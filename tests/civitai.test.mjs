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

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSUcAAAAASUVORK5CYII=', 'base64');
const config = { ...DEFAULT_CONFIG, civitaiKey: 'fake-civitai-key', wavespeedKey: 'fake-wavespeed-key' };
const input = (id = 'civitai-request-0001') => ({ id, provider: 'civitai', prompt: 'rainy street', source: { chatId: 'c', messageId: 'm', hash: 'h' }, cacheTag: '原标签' });
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'civitai-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
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
  const mapped = mapParameters(providerConfig({ ...config, civitaiParams: params }, 'civitai'), { width: 832, height: 1216 }, 'blur');
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
  assert.ok(calls.at(-1).includes('orchestration.civitai.com/v2/consumer/workflows/civitai-id'));
  await call('refresh', {}, ws.id); assert.ok(calls.at(-1).includes('api.wavespeed.ai'));
});
