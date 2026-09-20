import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserStore } from '../server/store.mjs';
import { DEFAULT_CONFIG, validateCivitai, publicConfig, updateConfig, safeError } from '../server/config.mjs';
import { CivitaiService, workflowBody, normalizeWorkflow } from '../server/civitai.mjs';
import { createHandlers } from '../server/index.mjs';
import { mapParameters, providerConfig } from '../wavespeed/client.js';
import { civitaiPayment, portableConfig } from '../shared/config.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSUcAAAAASUVORK5CYII=', 'base64');
const config = { ...DEFAULT_CONFIG, civitaiKey: 'fake-civitai-key', wavespeedKey: 'fake-wavespeed-key' };
const input = (id = 'civitai-request-0001') => ({ id, provider: 'civitai', prompt: 'rainy street', source: { chatId: 'c', messageId: 'm', hash: 'h' }, cacheTag: '原标签' });
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'civitai-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const dirs = { root, userImages: path.join(root, 'images') };
  return { db: new UserStore(dirs), dirs };
}

test('Civitai v2 estimate → submit → resume → image save, without duplicate paid submission', async t => {
  const { db } = await setup(t); let time = 0; let estimates = 0; let paid = 0; let estimateBody; let paidBody;
  const service = new CivitaiService(db, { now: () => time, checkUrl: async () => {}, fetcher: async (url, options) => {
    if (url.includes('whatif=true')) { estimates++; estimateBody = JSON.parse(options.body); assert.equal(options.headers.Authorization, `Bearer ${config.civitaiKey}`); return json({ cost: { total: 12 } }); }
    if (options.method === 'POST') { paid++; paidBody = JSON.parse(options.body); return json({ id: 'workflow-123', status: 'scheduled', steps: [] }); }
    if (url.includes('/workflows/')) return json({ id: 'workflow-123', status: 'succeeded', steps: [{ output: { images: [{ available: true, url: 'https://images.example/a.png' }, { available: false, url: 'https://images.example/blocked.png' }] } }] });
    assert.equal(options.headers, undefined); return new Response(png);
  } });
  const [a, b] = await Promise.all([service.submit(input(), config), service.submit(input('civitai-request-0002'), config)]);
  assert.equal(a.id, b.id); assert.equal(estimates, 1); assert.equal(paid, 1);
  assert.equal(a.estimatedBuzz, 12); assert.equal(a.provider, 'civitai');
  assert.equal(estimateBody.externalId, undefined); assert.equal(paidBody.externalId, 'chatu8-civitai-request-0001');
  assert.deepEqual(estimateBody.steps, paidBody.steps); assert.equal(paidBody.steps[0].$type, 'textToImage');
  assert.deepEqual(estimateBody.tips, { creators: 0, civitai: 0 });
  assert.deepEqual(paidBody.tips, estimateBody.tips);
  assert.deepEqual(a.requestedTips, paidBody.tips);
  assert.ok(Number.isInteger(paidBody.steps[0].input.seed));
  time = 5000;
  const job = await service.refresh(a.id, config);
  assert.equal(job.status, 'completed'); assert.equal(job.images.length, 1); assert.equal(job.cacheTag, '原标签');
  assert.deepEqual(await fs.readFile(path.join(db.imageDir, path.basename(job.images[0]))), png);
  assert.equal(paid, 1);
});

test('Civitai missing/over-budget estimate prevents a paid request and does not persist an ambiguous job', async t => {
  for (const response of [{ cost: { total: 101 } }, {}, { cost: { total: -1 } }]) {
    const { db } = await setup(t); let calls = 0;
    const service = new CivitaiService(db, { fetcher: async url => { calls++; assert.ok(url.endsWith('?whatif=true')); return json(response); } });
    await assert.rejects(service.submit(input(), config), /Buzz|预估/);
    assert.equal(calls, 1); assert.equal((await db.jobs()).length, 0);
  }
});

test('Civitai uncertain paid submission is not reposted; existing workflow can be recovered', async t => {
  const { db } = await setup(t); let paid = 0;
  const service = new CivitaiService(db, { fetcher: async (url, opts) => {
    if (url.includes('whatif')) return json({ cost: { total: 2 } });
    if (opts.method === 'POST') { paid++; throw new Error('connection lost'); }
    return json({ id: 'recovered-id', status: 'failed' });
  } });
  const job = await service.submit(input(), config); assert.equal(job.status, 'unknown');
  await service.submit(input('civitai-request-0002'), config); assert.equal(paid, 1);
  await service.recover(job.id, 'recovered-id');
  assert.equal((await service.refresh(job.id, config)).status, 'failed'); assert.equal(paid, 1);
});

test('Civitai failure states are terminal; available images only; invalid snapshots rejected', () => {
  for (const status of ['failed', 'expired', 'canceled']) assert.equal(normalizeWorkflow({ id: 'w', status }).status, 'failed');
  assert.throws(() => normalizeWorkflow({}), /响应无效/);
  assert.deepEqual(normalizeWorkflow({ id: 'w', status: 'succeeded', steps: [{ output: { images: [{ available: false, url: 'blocked' }, { available: true, url: 'ok' }] } }] }).outputs, ['ok']);
});

test('Civitai AIR, LoRA, negative prompt and dimensions follow v2 field names; secrets remain server-side', () => {
  const lora = 'urn:air:sdxl:lora:civitai:123@456';
  const params = { ...DEFAULT_CONFIG.civitaiParams, additionalNetworks: { [lora]: { strength: 0.8 } } };
  validateCivitai(config.civitaiModel, params);
  const mapped = mapParameters(providerConfig({ ...config, dimensionSource: 'request', civitaiParams: params }, 'civitai'), { width: 832, height: 1216 }, 'blur');
  assert.equal(mapped.negativePrompt, 'blur'); assert.equal(mapped.negative_prompt, undefined); assert.equal(mapped.width, 832); assert.deepEqual(mapped.additionalNetworks, params.additionalNetworks);
  assert.equal(publicConfig(config).civitaiKey, undefined); assert.equal(publicConfig(config).hasCivitaiKey, true);
  assert.equal(updateConfig(config, { civitaiKey: '' }).civitaiKey, config.civitaiKey);
  assert.equal(updateConfig(config, { clear_civitaiKey: true }).civitaiKey, '');
  assert.ok(!safeError(new Error(config.civitaiKey), config).includes(config.civitaiKey));
  for (const p of [{ prompt: 'override' }, { quantity: 16, batchSize: 2 }, { scheduler: 'EulerA' }, { seed: -1 }]) assert.throws(() => validateCivitai(config.civitaiModel, p));
  assert.throws(() => validateCivitai('https://example.com/model', params));
  assert.equal(workflowBody({ ...input(), model: config.civitaiModel, params, seed: 1 }).steps[0].input.additionalNetworks[lora].strength, 0.8);
});

test('server routes preserve each job provider after a backend switch, and keep identical prompts separate', async t => {
  const { db, dirs } = await setup(t); await db.saveConfig(config); let time = 0; const calls = [];
  const handlers = createHandlers({ now: () => time, fetcher: async (url, options) => {
    calls.push(url);
    if (url.includes('whatif')) return json({ cost: { total: 1 } });
    if (url.includes('orchestration.civitai.com')) return json({ id: 'civitai-id', status: options.method === 'POST' ? 'scheduled' : 'failed' });
    return json({ code: 200, data: { id: 'wavespeed-id', status: options.method === 'POST' ? 'created' : 'failed' } });
  } });
  async function call(name, body, id) {
    let result; let status = 200;
    const res = { json: v => { result = v; }, status: n => { status = n; return res; } };
    await handlers[name]({ user: { directories: dirs }, body, params: { id } }, res);
    assert.equal(status, 200, JSON.stringify(result)); return result;
  }
  const cv = await call('submit', input());
  const ws = await call('submit', { ...input('wavespeed-request-001'), provider: 'wavespeed' });
  assert.notEqual(cv.id, ws.id); time = 5000;
  assert.equal((await call('refresh', {}, cv.id)).status, 'failed');
  assert.ok(calls.some(url => url.includes('orchestration.civitai.com/v2/consumer/workflows/civitai-id')));
  assert.equal((await call('refresh', {}, ws.id)).status, 'failed');
  assert.ok(calls.some(url => url.includes('api.wavespeed.ai/api/v3/predictions/wavespeed-id/result')));
  assert.ok(!calls.some(url => url.includes('workflows/wavespeed-id') || url.includes('predictions/civitai-id')));
});

test('Krea 2 uses imageGen/comfy with a custom diffusion AIR for both estimate and submission', async t => {
  const { db } = await setup(t);
  const model = 'urn:air:krea2:checkpoint:civitai:2762538@3187539';
  const custom = { ...config, civitaiModel: model, civitaiParams: { width: 1024, height: 1024, steps: 8, cfgScale: 1, sampler: 'euler', scheduler: 'beta', quantity: 1 } };
  const bodies = [];
  const service = new CivitaiService(db, { fetcher: async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (url.includes('whatif')) return json({ cost: { total: 8 } });
    return json({ id: 'krea-workflow', status: 'scheduled', steps: [] });
  } });
  const result = await service.submit(input('krea-request-0001'), custom);
  assert.equal(result.taskId, 'krea-workflow'); assert.equal(bodies.length, 2);
  assert.equal(bodies[0].externalId, undefined); assert.ok(bodies[1].externalId);
  assert.deepEqual(bodies[0].steps, bodies[1].steps);
  assert.deepEqual(bodies[0].tips, { creators: 0, civitai: 0 });
  assert.deepEqual(bodies[1].tips, bodies[0].tips);
  const step = bodies[1].steps[0]; assert.equal(step.$type, 'imageGen');
  assert.deepEqual(step.input, { width: 1024, height: 1024, steps: 8, cfgScale: 1, quantity: 1, sampler: 'euler', scheduler: 'beta', engine: 'comfy', ecosystem: 'krea2', model: 'turbo', operation: 'createImage', diffusionModel: model, seed: step.input.seed, prompt: 'rainy street' });
  assert.ok(Number.isInteger(step.input.seed));
});

test('Krea 2 validates its own limits, diffusionmodel AIR, raw variant and LoRA format', () => {
  const model = 'urn:air:krea2:diffusionmodel:civitai:2762538@3197873';
  const lora = 'urn:air:krea2:lora:civitai:123@456';
  const params = { variant: 'raw', sampler: 'er_sde', scheduler: 'simple', cfgScale: 0, loras: { [lora]: 0.6 } };
  validateCivitai(model, params);
  const step = workflowBody({ id: 'krea-raw-0001', model, params, seed: 42, prompt: 'a landscape' }).steps[0];
  assert.equal(step.input.model, 'raw'); assert.equal(step.input.steps, 20); assert.equal(step.input.cfgScale, 0);
  assert.equal(step.input.variant, undefined); assert.equal(step.input.diffusionModel, model); assert.deepEqual(step.input.loras, params.loras);
  for (const p of [{scheduler:'eulerA'}, {width:2049}, {quantity:13}, {batchSize:2}, {additionalNetworks:{}}, {variant:'edit'}, {engine:'fal'}, {loras:{[lora]:'bad'}}]) assert.throws(() => validateCivitai(model,p));
  assert.throws(() => validateCivitai(config.civitaiModel,{scheduler:'beta'}));
});

test('Buzz currency settings validate, export and default safely for old configurations', () => {
  assert.deepEqual(civitaiPayment(), { currencies: ['yellow'], allowMatureContent: true, upgradeMode: 'manual' });
  for (const value of ['', 'automatic', ['yellow'], null, 'blue,yellow']) assert.throws(() => updateConfig(config, { civitaiCurrency: value }), /币种/);
  assert.equal(portableConfig(updateConfig(config, { civitaiCurrency: 'blue_green' })).civitaiCurrency, 'blue_green');
});

test('all four Buzz choices use identical explicit payment fields for estimates and paid requests', async t => {
  for (const currency of ['yellow', 'blue', 'green', 'blue_green']) {
    const { db } = await setup(t); const calls = [];
    const service = new CivitaiService(db, { fetcher: async (url, opts) => {
      calls.push({ url, method: opts.method, body: JSON.parse(opts.body) });
      return json(url.includes('whatif') ? { cost: { total: 9, factors: { test: 1 }, fees: { lora: 2 }, variable: true }, transactions: { list: [{ type: 'debit', accountType: currency === 'blue_green' ? 'blue' : currency, amount: 9 }], insufficientBuzz: false } } : { id: 'paid', status: 'scheduled' });
    } });
    const job = await service.submit(input(), { ...config, civitaiCurrency: currency });
    assert.equal(calls.length, 2); assert.equal(job.civitaiCurrency, currency);
    for (const call of calls) {
      assert.deepEqual(call.body.currencies, currency === 'blue_green' ? ['blue', 'green'] : [currency]);
      assert.equal(call.body.allowMatureContent, currency === 'yellow');
      assert.equal(call.body.upgradeMode, 'manual'); assert.equal(call.body.ephemeral, undefined);
      assert.deepEqual(call.body.tips, { creators: 0, civitai: 0 });
    }
    assert.equal(job.buzzEstimate.cost.variable, true); assert.deepEqual(job.buzzEstimate.cost.fees, { lora: 2 });
    assert.equal((await db.job(job.id)).buzzEstimate.transactions.list[0].amount, 9);
  }
});

test('nonzero or malformed quoted tips stop the paid request, including when within budget', async t => {
  for (const tips of [{ creators: 9, civitai: 0 }, { creators: 0, civitai: 9 }, { creators: 9, civitai: 9 }, { creators: '0', civitai: 0 }, {}, []]) {
    const { db } = await setup(t); let calls = 0;
    const service = new CivitaiService(db, { fetcher: async url => {
      calls++; assert.ok(url.includes('whatif'));
      return json({ cost: { total: 27, tips } });
    } });
    await assert.rejects(service.submit(input(), config), /小费/);
    assert.equal(calls, 1); assert.deepEqual(await db.jobs(), []);
  }
});

test('zero tips preserve paid base cost and licensing fees without claiming generation is free', async t => {
  const { db } = await setup(t); const bodies = [];
  const cost = { total: 12, base: 9, tips: { creators: 0, civitai: 0 }, fees: { lora: 3 } };
  const service = new CivitaiService(db, { fetcher: async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return json(url.includes('whatif') ? { cost } : { id: 'no-tips', status: 'scheduled', cost });
  } });
  const job = await service.submit(input(), config);
  assert.equal(bodies.length, 2); assert.equal(job.estimatedBuzz, 12);
  assert.deepEqual(job.buzzCost, cost); assert.deepEqual(job.buzzEstimate.cost, cost);
  assert.deepEqual((await db.job(job.id)).requestedTips, { creators: 0, civitai: 0 });
});

test('insufficient selected Buzz prevents paid POST instead of falling back to another currency', async t => {
  const { db } = await setup(t); let calls = 0;
  const service = new CivitaiService(db, { fetcher: async url => {
    calls++; assert.ok(url.includes('whatif'));
    return json({ cost: { total: 9 }, transactions: { insufficientBuzz: true, list: [] } });
  } });
  await assert.rejects(service.submit(input(), config), /余额不足/);
  assert.equal(calls, 1); assert.deepEqual(await db.jobs(), []);
});

test('queued jobs freeze their Buzz choice even after settings change or service restarts', async t => {
  const { db } = await setup(t); const bodies = [];
  const opts = { fetcher: async (url, req) => {
    bodies.push(JSON.parse(req.body));
    return json(url.includes('whatif') ? { cost: { total: 9 } } : { id: 'w-' + bodies.length, status: 'scheduled' });
  } };
  const service = new CivitaiService(db, opts);
  const blue = { ...config, civitaiCurrency: 'blue' };
  const first = await service.submit(input(), blue);
  // The same prompt with a different currency is a distinct request.
  const second = await service.submit(input('civitai-request-0002'), config);
  assert.notEqual(first.id, second.id);
  const queued = await service.submit({ ...input('civitai-request-0003'), prompt: 'second landscape' }, blue);
  assert.equal(queued.status, 'queued'); assert.equal(bodies.length, 4);
  await db.saveJob({ ...first, status: 'failed' });
  const restarted = new CivitaiService(db, opts);
  await restarted.startQueued(queued.id, config);
  assert.equal(bodies.length, 6);
  for (const body of bodies.slice(-2)) assert.deepEqual(body.currencies, ['blue']);
});

test('withheld output and billing are visible without automatic upgrade or duplicate POST', async t => {
  const { db } = await setup(t); let time = 0; const methods = [];
  const transactions = { list: [{ type: 'debit', amount: 9, accountType: 'blue' }] };
  const service = new CivitaiService(db, { now: () => time, fetcher: async (url, opts) => {
    methods.push(opts.method || 'GET');
    if (url.includes('whatif')) return json({ cost: { total: 9 } });
    if (opts.method === 'POST') return json({ id: 'withheld', status: 'scheduled' });
    return json({ id: 'withheld', status: 'succeeded', cost: { total: 9 }, transactions, steps: [{ output: { blobs: [{ type: 'image', available: false, blockedReason: 'mature content', url: 'https://images.example/blocked.png' }] } }] });
  } });
  const job = await service.submit(input(), { ...config, civitaiCurrency: 'blue' }); time = 5000;
  const result = await service.refresh(job.id, config);
  assert.equal(result.status, 'failed'); assert.match(result.error, /不会自动换币/);
  assert.deepEqual(result.buzzTransactions, transactions); assert.equal(result.buzzCost.total, 9);
  assert.deepEqual(result.images, []); await service.refresh(job.id, config);
  assert.deepEqual(methods, ['POST', 'POST', 'GET']);
  assert.deepEqual(normalizeWorkflow({ status: 'succeeded', steps: [{ output: { blobs: [{ type: 'image', available: true, url: 'https://images.example/ok.png' }] } }] }).outputs, ['https://images.example/ok.png']);
});
