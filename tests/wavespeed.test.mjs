import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { UserStore } from '../server/store.mjs';
import { DEFAULT_CONFIG, updateConfig, publicConfig, safeError } from '../server/config.mjs';
import { WaveSpeedService, isPublicAddress } from '../server/wavespeed.mjs';
import { createHandlers } from '../server/index.mjs';
import { createWaveSpeedAdapter } from '../wavespeed/adapter.js';
import { mapParameters, waitForJob } from '../wavespeed/client.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const prediction = data => json({ code: 200, data });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSUcAAAAASUVORK5CYII=', 'base64');
const config = { ...DEFAULT_CONFIG, wavespeedKey: 'test-secret-not-real' };
const input = (id = 'request-000000000001') => ({ id, prompt: 'A character in the rain', cacheTag: '原消息图片标签', change: '修改后的提示词', source: { chatId: 'chat-A', messageId: 'message-A', swipeId: 0, hash: 'hash-A' } });
async function store(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatu8-wave-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return new UserStore({ root: dir, userImages: path.join(dir, 'user/images') });
}

test('submit → processing → downloaded PNG; task ID survives a new service instance', async t => {
  const db = await store(t); let time = 1000; let posts = 0; let polls = 0;
  const fetcher = async (url, options) => {
    if (options.method === 'POST') { posts++; assert.equal(JSON.parse(options.body).prompt, input().prompt); return prediction({ id: 'pred_test', status: 'created' }); }
    if (url.endsWith('/result')) { polls++; return prediction(polls === 1 ? { status: 'processing' } : { status: 'completed', outputs: ['https://image.example/test.png'] }); }
    assert.equal(options.headers, undefined, 'API credentials must never be forwarded to image hosts');
    return new Response(png);
  };
  let service = new WaveSpeedService(db, { fetcher, checkUrl: async () => {}, now: () => time });
  const created = await service.submit(input(), config);
  assert.equal(created.taskId, 'pred_test');
  await service.refresh(created.id, config); assert.equal(polls, 0, 'respect minimum polling interval');
  time += 3000; assert.equal((await service.refresh(created.id, config)).status, 'processing');
  const reopened = new UserStore({ root: path.dirname(db.root), userImages: path.dirname(db.imageDir) });
  service = new WaveSpeedService(reopened, { fetcher, checkUrl: async () => {}, now: () => time });
  time += 3000; const completed = await service.refresh(created.id, config);
  assert.equal(completed.status, 'completed'); assert.equal(posts, 1);
  assert.equal(completed.cacheTag, '原消息图片标签'); assert.equal(completed.change, '修改后的提示词');
  assert.deepEqual(await fs.readFile(path.join(db.imageDir, path.basename(completed.images[0]))), png);
});

test('concurrent identical submissions and repeated request IDs cause one paid POST', async t => {
  const db = await store(t); let posts = 0;
  const service = new WaveSpeedService(db, { fetcher: async () => { posts++; return prediction({ id: 'pred_one', status: 'created' }); } });
  const [a, b] = await Promise.all([service.submit(input(), config), service.submit(input('request-000000000002'), config)]);
  assert.equal(a.id, b.id); assert.equal(posts, 1);
  await service.submit(input(), config); assert.equal(posts, 1);
});

test('ambiguous network failure is persisted; recovery queries existing ID without reposting', async t => {
  const db = await store(t); let posts = 0;
  const service = new WaveSpeedService(db, { fetcher: async (_url, options) => {
    if (options.method === 'POST') { posts++; throw new Error('network dropped'); }
    return prediction({ status: 'failed', error: 'Provider failed' });
  } });
  const a = await service.submit(input(), config); assert.equal(a.status, 'unknown');
  await service.submit(input('request-000000000002'), config); assert.equal(posts, 1);
  await service.recover(a.id, 'pred_found_in_history');
  assert.equal((await service.refresh(a.id, config)).status, 'failed'); assert.equal(posts, 1);
});

test('explicit authentication rejection fails without ambiguous status and does not leak Key', async t => {
  const db = await store(t);
  const service = new WaveSpeedService(db, { fetcher: async () => json({ error: { message: `bad key ${config.wavespeedKey}` } }, 401) });
  const job = await service.submit(input(), config);
  assert.equal(job.status, 'failed'); assert.ok(!job.error.includes(config.wavespeedKey));
});

test('download failure can recover without a new generation or result request', async t => {
  const db = await store(t); let posts = 0; let queries = 0; let downloads = 0; let time = 1000;
  const service = new WaveSpeedService(db, { now: () => time, checkUrl: async () => {}, fetcher: async (url, options) => {
    if (options.method === 'POST') { posts++; return prediction({ id: 'pred_download', status: 'created' }); }
    if (url.endsWith('/result')) { queries++; return prediction({ status: 'completed', outputs: ['https://image.example/image.png'] }); }
    downloads++; return downloads === 1 ? new Response('bad gateway', { status: 502 }) : new Response(png);
  } });
  const job = await service.submit(input(), config); time += 3000;
  assert.equal((await service.refresh(job.id, config)).status, 'download_failed');
  time += 11000; assert.equal((await service.refresh(job.id, config)).status, 'completed');
  assert.equal(posts, 1); assert.equal(queries, 1); assert.equal(downloads, 2);
});

test('failed, cancelled, timeout and deleted stop polling', async t => {
  for (const status of ['failed', 'cancelled', 'timeout', 'deleted']) {
    const db = await store(t); let time = 1; let polls = 0;
    const service = new WaveSpeedService(db, { now: () => time, fetcher: async (_url, opts) => opts.method === 'POST' ? prediction({ id: 'p', status: 'created' }) : (polls++, prediction({ status })) });
    const job = await service.submit(input(), config); time = 5000;
    assert.equal((await service.refresh(job.id, config)).status, 'failed');
    await service.refresh(job.id, config); assert.equal(polls, 1);
  }
});

test('configuration retains keys on blank, supports explicit clearing, rejects unsafe parameters', () => {
  const saved = updateConfig(config, { wavespeedKey: '', fixedPrompt: 'illustration' });
  assert.equal(saved.wavespeedKey, config.wavespeedKey);
  assert.equal(publicConfig(saved).wavespeedKey, undefined);
  assert.equal(updateConfig(saved, { clear_wavespeedKey: true }).wavespeedKey, '');
  assert.throws(() => updateConfig(saved, { imageModel: '../../admin' }));
  assert.throws(() => updateConfig(saved, { imageParams: { prompt: 'override' } }));
  assert.throws(() => updateConfig(saved, { imageParams: { enable_sync_mode: true } }));
  assert.throws(() => updateConfig(saved, { imageParams: [] }));
  assert.ok(!safeError(new Error(config.wavespeedKey), saved).includes(config.wavespeedKey));
});

test('per-user server sessions do not share credentials or jobs; anonymous requests rejected', async t => {
  const a = await store(t); const b = await store(t); const handlers = createHandlers();
  const req = db => ({ user: { directories: { root: path.dirname(db.root), userImages: path.dirname(db.imageDir) } } });
  async function call(handler, request) { let result, code = 200; await handler(request, { status(v) { code = v; return this; }, json(v) { result = v; } }); return { code, result }; }
  await call(handlers.configSave, { ...req(a), body: { wavespeedKey: 'user-a-secret' } });
  assert.equal((await call(handlers.configGet, req(a))).result.hasWavespeedKey, true);
  assert.equal((await call(handlers.configGet, req(b))).result.hasWavespeedKey, false);
  assert.equal((await call(handlers.configGet, {})).code, 401);
});

test('parameter mapping respects model choices and sends negatives only when enabled', () => {
  assert.deepEqual(mapParameters({ ...config, dimensionSource: 'request' }, { width: '768', height: '1024' }, 'bad'), { size: '768*1024' });
  assert.deepEqual(mapParameters({ ...config, sizeMode: 'none', negativeField: 'negative_prompt' }, { width: 768, height: 1024 }, 'bad'), { size: '1024*1024', negative_prompt: 'bad' });
  assert.deepEqual(mapParameters({ ...config, dimensionSource: 'request', imageParams: {}, sizeMode: 'width_height' }, { width: 768, height: 1024 }), { width: 768, height: 1024 });
});

test('wait timeout and temporary query errors never resubmit paid generation', async () => {
  let time = 0; const routes = [];
  await assert.rejects(waitForJob(async route => { routes.push(route); throw new Error('temporary'); }, { id: 'job', taskId: 'pred', status: 'processing' }, { now: () => time, sleep: async ms => { time += ms; }, timeout: 7000 }), /任务还未完成/);
  assert.ok(routes.length > 0); assert.ok(routes.every(r => r === '/jobs/job/refresh'));
});

test('adapter reuses original events, prompt helpers and cache; switching mode removes listener', async () => {
  const events = new EventEmitter(); const calls = []; const local = { mode: 'wavespeed', cache: '1' };
  const completed = { id: 'server-job', taskId: 'pred', status: 'completed', images: ['/user/images/wavespeed-illustrator/abcdefghijklmnop-0.png'], cacheTag: 'original tag', prompt: 'resolved', model: 'test/model', params: {} };
  const deps = {
    context: () => ({ getCurrentChatId: () => 'chat', characterId: 0, characters: [{ avatar: 'a.png' }] }), settings: () => local, enabled: () => true,
    events, eventTypes: { GENERATE_IMAGE_REQUEST: 'request', GENERATE_IMAGE_RESPONSE: 'response' }, initializeImages: () => calls.push('scan'),
    replacePrompt: async p => { calls.push('replace'); return { modifiedPrompt: p, insertions: {} }; },
    composePrompt: async (_a, p) => { calls.push('compose'); return p; }, parseRoles: () => ({}), replaceCharacter: p => p,
    cacheImage: async tag => { assert.equal(tag, 'original tag'); calls.push('cache'); }, saveSettings: () => calls.push('save'),
    taskQueue: { addTask: () => 'queue', updateStatus() {}, completeTask() {} }, record() {}, log() {},
    readImage: async () => 'data:image/png;base64,test',
    api: async route => route === '/config' ? publicConfig(config) : completed,
    wait: async (_api, job) => job,
  };
  const adapter = createWaveSpeedAdapter(deps);
  adapter.updateMode(); adapter.updateMode(); assert.equal(events.listenerCount('request'), 1);
  const response = new Promise(resolve => events.once('response', resolve));
  await adapter.generate({ id: 'req', prompt: 'original tag' });
  const result = await response;
  assert.equal(result.id, 'req'); assert.equal(result.success, true); assert.equal(result.imageData, 'data:image/png;base64,test');
  assert.ok(calls.includes('replace') && calls.includes('compose') && calls.includes('cache'));
  local.mode = 'sd'; adapter.updateMode(); assert.equal(events.listenerCount('request'), 0);
});

test('image download address validation rejects loopback and private address families', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.3.4', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true); assert.equal(isPublicAddress('2606:4700::1111'), true);
});
