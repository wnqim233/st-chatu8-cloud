import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserStore, createBrowserApi } from '../wavespeed/browser.js';
import { waitForJob } from '../wavespeed/client.js';

const json = body => new Response(JSON.stringify(body));
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const input = (n, provider = 'wavespeed') => ({ id: `queue-request-${String(n).padStart(5, '0')}`, provider, prompt: `A landscape, scene ${n}`, source: { chatId: 'original-chat', messageId: `message-${n}`, hash: `hash-${n}` } });

async function fixture() {
  const data = new Map();
  const store = new BrowserStore('queue-test', { locks: undefined });
  // Keep real journal locking, retention, downloads and serialization; replace
  // only the IndexedDB transaction boundary for Node. Browser fixture uses IDB.
  store.access = async (_mode, fn) => fn({
    get: key => ({ result: structuredClone(data.get(key)) }),
    put: (value, key) => { data.set(key, structuredClone(value)); return {}; },
    delete: key => data.delete(key),
  })?.result;
  const paid = [], active = new Set(), status = new Map(), estimates = [];
  let time = 1000, highWater = 0, estimateCost = 2, loseNext = false, downloadFails = false, downloadGate;
  const fetcher = async (url, opts = {}) => {
    if (url.startsWith('https://images.example/')) {
      if (downloadGate) await downloadGate;
      if (downloadFails) throw Error('download offline');
      return new Response(png);
    }
    const civitai = url.includes('civitai.com');
    if (url.includes('whatif')) { estimates.push(JSON.parse(opts.body)); return json({ cost: { total: estimateCost } }); }
    if (opts.method === 'POST') {
      const id = `paid-${paid.length + 1}`;
      paid.push({ id, civitai, body: JSON.parse(opts.body) }); active.add(id); status.set(id, 'processing');
      highWater = Math.max(highWater, active.size);
      if (loseNext) { loseNext = false; throw Error('connection dropped after accepting'); }
      return json(civitai ? { id, status: 'scheduled' } : { code: 200, data: { id, status: 'created' } });
    }
    const id = url.match(/(?:predictions|workflows)\/([^/]+)/)?.[1];
    assert.ok(status.has(id), `query known task only: ${url}`);
    const current = status.get(id);
    if (['completed', 'failed'].includes(current)) active.delete(id);
    return json(civitai ? { id, status: current === 'completed' ? 'succeeded' : current, steps: [{ output: { images: [{ available: true, url: 'https://images.example/test.png' }] } }] } : { code: 200, data: { id, status: current, outputs: ['https://images.example/test.png'] } });
  };
  const settings = { cloudStorageId: 'queue-test' };
  const reopen = () => createBrowserApi({ settings: () => settings }, { storeFactory: () => store, fetcher, now: () => time });
  const api = reopen();
  await api('/config', { wavespeedKey: 'fake-wave-key', civitaiKey: 'fake-civitai-key' });
  return { api, reopen, store, paid, active, status, estimates, input,
    advance: () => { time += 5000; }, highWater: () => highWater,
    cost: n => { estimateCost = n; }, lose: () => { loseNext = true; }, failDownload: value => { downloadFails = value; }, delayDownload: promise => { downloadGate = promise; },
  };
}

test('five mixed-provider requests queue FIFO, refill either slot and retain each message; no duplicate paid POST', async () => {
  const f = await fixture();
  const jobs = await Promise.all([1, 2, 3, 4, 5].map(n => f.api('/jobs', input(n, n % 2 ? 'wavespeed' : 'civitai'))));
  assert.deepEqual(jobs.map(j => j.status), ['submitted', 'submitted', 'queued', 'queued', 'queued']);
  assert.equal(f.paid.length, 2); assert.equal(f.estimates.length, 1, 'waiting Civitai job is not estimated/submitted early');
  assert.equal((await f.api('/jobs', input(3))).id, jobs[2].id);
  const duplicate = { ...input(3), id: 'queue-duplicate-00003' };
  assert.equal((await f.api('/jobs', duplicate)).id, jobs[2].id);
  f.status.set('paid-2', 'completed'); f.advance();
  await Promise.all([f.api('/jobs/tick', {}), f.api(`/jobs/${jobs[4].id}/refresh`, {})]);
  assert.equal(f.paid.length, 3); assert.equal(f.paid[2].body.prompt, input(3).prompt);
  assert.equal((await f.store.job(jobs[1].id)).status, 'completed');
  f.status.set('paid-1', 'failed'); f.advance(); await f.api('/jobs/tick', {});
  assert.equal(f.paid.length, 4); assert.equal(f.paid[3].civitai, true);
  assert.equal(f.estimates.length, 2);
  for (let i = 0; i < 3; i++) { for (const id of f.active) f.status.set(id, 'completed'); f.advance(); await f.api('/jobs/tick', {}); }
  assert.equal(f.paid.length, 5); assert.equal(f.highWater(), 2);
  const final = await f.store.jobs();
  assert.equal(final.filter(j => j.status === 'completed').length, 4);
  assert.equal(final.filter(j => j.status === 'failed').length, 1);
  for (let n = 1; n <= 5; n++) assert.deepEqual(final.find(j => j.id === input(n).id).source, { ...input(n).source, swipeId: 0 });
  assert.deepEqual(f.paid.filter(j => !j.civitai).map(j => j.body.prompt), [1, 3, 5].map(n => input(n).prompt));
});

test('queued work resumes after reopening; two competing schedulers do not double-submit; queued settings are frozen', async () => {
  const f = await fixture();
  for (let n = 1; n <= 4; n++) await f.api('/jobs', input(n));
  const original = await f.store.job(input(3).id);
  await f.api('/config', { imageModel: 'other/model', imageParams: { size: '512*512' } });
  const reopened = f.reopen();
  f.status.set('paid-1', 'completed'); f.advance();
  await Promise.all([f.api('/jobs/tick', {}), reopened('/jobs/tick', {})]);
  assert.equal(f.paid.length, 3); assert.equal(f.highWater(), 2);
  const resumed = await f.store.job(input(3).id);
  assert.deepEqual(resumed.params, original.params); assert.equal(resumed.model, original.model);
  assert.equal(resumed.startedAt, 6000); assert.equal(resumed.createdAt, 1000);
});

test('cancel only unsubmitted waiting jobs, without consuming an estimate or a paid request', async () => {
  const f = await fixture();
  for (let n = 1; n <= 4; n++) await f.api('/jobs', input(n, 'civitai'));
  await f.api(`/jobs/${input(3).id}/cancel`, {});
  await assert.rejects(f.api(`/jobs/${input(1).id}/cancel`, {}), /只能取消/);
  f.status.set('paid-1', 'failed'); f.advance(); await f.api('/jobs/tick', {});
  assert.equal(f.paid.length, 3); assert.equal(f.estimates.length, 3);
  assert.equal((await f.store.job(input(3).id)).status, 'cancelled');
  assert.equal((await f.store.job(input(4).id)).status, 'submitted');
});

test('unknown paid submission reserves a slot until recovered; queue never retries it', async () => {
  const f = await fixture(); f.lose();
  for (let n = 1; n <= 4; n++) await f.api('/jobs', input(n));
  assert.equal((await f.store.job(input(1).id)).status, 'unknown');
  f.status.set('paid-2', 'completed'); f.advance(); await f.api('/jobs/tick', {});
  assert.equal(f.paid.length, 3); assert.equal((await f.store.job(input(4).id)).status, 'queued');
  f.advance(); await f.api('/jobs/tick', {}); assert.equal(f.paid.length, 3);
  await f.api(`/jobs/${input(1).id}/recover`, { taskId: 'paid-1' });
  f.status.set('paid-1', 'completed'); f.advance(); await f.api('/jobs/tick', {});
  assert.equal(f.paid.length, 4); assert.equal(f.highWater(), 2);
});

test('queued preflight failure releases its place and proceeds to the next request', async () => {
  const f = await fixture();
  for (let n = 1; n <= 2; n++) await f.api('/jobs', input(n));
  await f.api('/jobs', input(3, 'civitai')); await f.api('/jobs', input(4)); f.cost(1000);
  f.status.set('paid-1', 'failed'); f.advance(); await f.api('/jobs/tick', {});
  assert.equal((await f.store.job(input(3).id)).status, 'failed');
  assert.match((await f.store.job(input(3).id)).error, /Buzz/);
  assert.equal(f.paid.length, 3); assert.equal(f.paid[2].body.prompt, input(4).prompt);
});

test('download failure frees platform capacity while preserving the original task for download retry', async () => {
  const f = await fixture(); for (let n = 1; n <= 3; n++) await f.api('/jobs', input(n));
  f.failDownload(true); f.status.set('paid-1', 'completed'); f.advance(); await f.api('/jobs/tick', {});
  assert.equal((await f.store.job(input(1).id)).status, 'download_failed'); assert.equal(f.paid.length, 3);
  f.failDownload(false); f.advance(); f.advance(); await f.api('/jobs/tick', {});
  assert.equal((await f.store.job(input(1).id)).status, 'completed'); assert.equal(f.paid.length, 3);
});

test('queue waiting time does not consume the generation timeout, cancellation ends the waiter', async () => {
  let time = 0, calls = 0;
  const job = { id: 'queued-job', status: 'queued' };
  const result = await waitForJob(async () => ({ ...job, status: ++calls < 5 ? 'queued' : calls < 7 ? 'processing' : 'completed' }), job, { now: () => time, sleep: async ms => { time += ms; }, timeout: 9000 });
  assert.equal(result.status, 'completed'); assert.ok(time > 9000);
  await assert.rejects(waitForJob(async () => ({ ...job, status: 'cancelled' }), job, { sleep: async () => {} }), /取消/);
});


test('refill happens on platform completion, even while the finished image is still downloading', async () => {
  const f = await fixture(); for (let n = 1; n <= 3; n++) await f.api('/jobs', input(n));
  let release;
  f.delayDownload(new Promise(resolve => { release = resolve; }));
  f.status.set('paid-1', 'completed'); f.advance();
  const tick = f.api('/jobs/tick', {});
  try {
    for (let n = 0; n < 20 && f.paid.length < 3; n++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.paid.length, 3);
    assert.equal((await f.store.job(input(1).id)).status, 'download_failed');
    assert.equal(f.highWater(), 2);
  } finally { release(); await tick; }
  assert.equal((await f.store.job(input(1).id)).status, 'completed');
});
