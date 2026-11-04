import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanKrea2Prompt, parseKrea2Roles } from '../shared/krea-prompt.js';
import { DEFAULT_CONFIG, migrateKrea2Defaults, updateConfig, publicConfig, portableConfig } from '../shared/config.js';
import { workflowBody } from '../shared/civitai.js';
import { createWaveSpeedAdapter } from '../wavespeed/adapter.js';
import { createBrowserApi, BrowserStore } from '../wavespeed/browser.js';
import { providerConfig } from '../wavespeed/client.js';

const model = 'urn:air:krea2:diffusionmodel:civitai:100@200+300';
const legacy = () => ({ ...structuredClone(DEFAULT_CONFIG), civitaiModel: model, civitaiKey: 'fixture-key', revision: 8,
  civitaiParams: { width: 1024, height: 1024, steps: 8, cfgScale: 1, sampler: 'euler', scheduler: 'beta', quantity: 1, loras: { 'urn:air:krea2:lora:civitai:400@500': 0.6 } } });
const flat = 'A car cabin at dusk, 768x512 | a woman wearing glasses, hands on the wheel, 66cm waist.|centers: | an adult man in the passenger seat, a white shirt.|centers:';

test('flat Krea prompt removes size and empty centers while retaining both character descriptions', () => {
  assert.equal(cleanKrea2Prompt(flat), 'A car cabin at dusk\n\na woman wearing glasses, hands on the wheel, 66cm waist.\n\nan adult man in the passenger seat, a white shirt.');
  assert.equal(cleanKrea2Prompt(cleanKrea2Prompt(flat)), cleanKrea2Prompt(flat));
  assert.equal(cleanKrea2Prompt('a photograph of a 768x512 screen, 36C, 66cm waist, stripes in blue | gold'), 'a photograph of a 768x512 screen, 36C, 66cm waist, stripes in blue | gold');
  assert.equal(cleanKrea2Prompt('portrait, 1024×1024, soft light'), 'portrait, soft light');
});

test('Krea role parsing keeps multiline descriptions and semicolons, with UC separate from positive text', () => {
  const parsed = parseKrea2Roles('Scene Composition:car cabin, 768x512;\nCharacter 1 Prompt:a woman\nwearing glasses; beige coat|centers:a3; Character 1 UC:wrong outfit; Character 2 Prompt:an adult man\nin a white shirt|centers:;');
  assert.equal(parsed['Scene Composition'], 'car cabin');
  assert.equal(parsed['Character 1 Prompt'], 'a woman\nwearing glasses; beige coat');
  assert.equal(parsed['Character 1 UC'], 'wrong outfit');
  assert.equal(parsed['Character 2 Prompt'], 'an adult man\nin a white shirt');
  assert.equal(parseKrea2Roles('an ordinary landscape'), null);
});

test('adapter submits cleaned Krea text and copies the same text without changing dimensions or model parameters', async () => {
  const config = providerConfig(migrateKrea2Defaults(legacy()), 'civitai');
  const history = [], reads = [];
  const adapter = createWaveSpeedAdapter({ context: () => ({ chatId: 'fixture' }), settings: () => ({ mode: 'civitai' }),
    api: async (route, body) => { assert.equal(body, undefined); reads.push(route); return route === '/jobs' ? history : config; },
    replacePrompt: async text => ({ modifiedPrompt: text.replace('dusk', 'evening'), insertions: {} }),
    replaceCharacter: text => text,
    composePrompt: async (prefix, text, suffix) => [prefix, text, suffix].filter(Boolean).join(', '),
  });
  const prepared = await adapter.prepare({ prompt: flat, width: 768, height: 512 }, config);
  assert.equal(prepared.prompt, cleanKrea2Prompt(flat).replace('dusk', 'evening'));
  assert.equal(prepared.params.width, 1024); assert.equal(prepared.params.height, 1024);
  assert.equal(prepared.params.scheduler, 'simple');
  assert.deepEqual(prepared.params.loras, config.civitaiParams.loras);
  assert.deepEqual(await adapter.promptForCopy({ prompt: flat }), { text: prepared.prompt });
  const structured = await adapter.prepare({ prompt: 'Scene Composition:car cabin, 768x512; Character 1 Prompt:woman\nwith glasses|centers:; Character 1 UC:blur; Character 2 Prompt:adult passenger|centers:;' }, config);
  assert.equal(structured.prompt, 'car cabin\n\nwoman\nwith glasses\n\nadult passenger');
  history.push({ source: { chatId: JSON.stringify(['chat', 'fixture']) }, cacheTag: flat, prompt: flat, createdAt: 1, status: 'failed' });
  assert.deepEqual(await adapter.promptForCopy({ prompt: flat }), { text: flat, actual: true }, 'old task copy must describe its actual historic request');
  const ordinary = await adapter.prepare({ prompt: flat }, { ...config, imageModel: 'some-provider/model' });
  assert.equal(ordinary.prompt, flat.replace('dusk', 'evening'), 'other backends keep their behavior');
});

test('upgrade changes only the old Turbo scheduler once, preserving credentials, AIR, LoRAs and spending controls', () => {
  const old = legacy(), before = structuredClone(old), next = migrateKrea2Defaults(old, () => 123);
  assert.deepEqual(old, before); assert.equal(next.civitaiParams.scheduler, 'simple');
  assert.deepEqual({ ...next.civitaiParams, scheduler: 'beta' }, old.civitaiParams);
  for (const field of ['civitaiModel', 'civitaiKey', 'civitaiMaxBuzz', 'civitaiCurrency']) assert.equal(next[field], old[field]);
  assert.equal(next.revision, 9); assert.equal(next.savedAt, 123);
  assert.equal(migrateKrea2Defaults(next), next);
  const intentional = updateConfig(next, { civitaiParams: { ...next.civitaiParams, scheduler: 'beta' } });
  assert.equal(migrateKrea2Defaults(intentional).civitaiParams.scheduler, 'beta');
  assert.equal(publicConfig(next).krea2DefaultsVersion, undefined);
  assert.equal(portableConfig(next).krea2DefaultsVersion, undefined);
  for (const params of [{ variant: 'raw' }, { sampler: 'heun' }, { cfgScale: 1.5 }, { steps: 12 }, { scheduler: 'karras' }]) {
    const custom = { ...old, civitaiParams: { ...old.civitaiParams, ...params } };
    assert.deepEqual(migrateKrea2Defaults(custom).civitaiParams, custom.civitaiParams);
  }
  assert.deepEqual(migrateKrea2Defaults(DEFAULT_CONFIG).civitaiParams, DEFAULT_CONFIG.civitaiParams);
});

test('browser upgrade persists before new requests, survives reopening and does not change old queued jobs', async () => {
  const data = new Map([['config', legacy()], ['jobs', [{ id: 'old-job', provider: 'civitai', status: 'queued', prompt: flat, params: { scheduler: 'beta' } }]]]);
  const oldJob = structuredClone(data.get('jobs'));
  let saves = 0;
  const storeFactory = () => {
    const store = new BrowserStore('krea-migration', { locks: undefined });
    store.read = async key => structuredClone(data.get(key));
    store.write = async (key, value) => { if (key === 'config') saves++; data.set(key, structuredClone(value)); };
    store.expose = async value => value;
    return store;
  };
  const deps = { settings: () => ({ cloudStorageId: 'krea-migration' }), saveSettings() {} };
  const opts = { storeFactory, fetcher: () => { throw Error('Migration must not contact a provider'); } };
  const api = createBrowserApi(deps, opts);
  const configs = await Promise.all([api('/config'), api('/config'), api('/jobs')]);
  assert.equal(configs[0].civitaiParams.scheduler, 'simple'); assert.equal(saves, 1);
  assert.deepEqual(data.get('jobs'), oldJob);
  const reopened = createBrowserApi(deps, opts);
  assert.equal((await reopened('/config')).civitaiParams.scheduler, 'simple'); assert.equal(saves, 1);
  await reopened('/config', { civitaiParams: { ...data.get('config').civitaiParams, scheduler: 'beta' } });
  assert.equal((await createBrowserApi(deps, opts)('/config')).civitaiParams.scheduler, 'beta');
});

test('failed upgrade persistence blocks generation and can retry without a provider request', async () => {
  const store = new BrowserStore('failed-migration', { locks: undefined });
  let config = legacy(), fail = true, calls = 0;
  store.config = async () => config;
  store.saveConfig = async value => { if (fail) throw Error('Storage failed'); config = value; };
  const api = createBrowserApi({ settings: () => ({ cloudStorageId: 'failed-migration' }) }, { storeFactory: () => store, fetcher: () => { calls++; throw Error('Unexpected request'); } });
  await assert.rejects(api('/jobs', { provider: 'civitai' }), /Storage failed/);
  assert.equal(config.civitaiParams.scheduler, 'beta'); assert.equal(calls, 0);
  fail = false; assert.equal((await api('/config')).civitaiParams.scheduler, 'simple');
});

test('Krea default workflow uses Simple while explicit choices and zero-tip payment stay intact', () => {
  const base = { id: 'fixture', model, params: {}, prompt: 'a car', civitaiCurrency: 'yellow' };
  const estimate = workflowBody(base, true), paid = workflowBody(base);
  assert.equal(paid.steps[0].input.scheduler, 'simple'); assert.deepEqual(estimate.steps, paid.steps);
  assert.equal(paid.steps[0].input.diffusionModel, model);
  assert.deepEqual(paid.tips, { creators: 0, civitai: 0 }); assert.equal(paid.upgradeMode, 'manual');
  assert.equal(workflowBody({ ...base, params: { scheduler: 'beta' } }).steps[0].input.scheduler, 'beta');
});
