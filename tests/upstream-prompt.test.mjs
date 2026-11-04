import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createWaveSpeedAdapter } from '../wavespeed/adapter.js';
import { DEFAULT_CONFIG } from '../server/config.mjs';

test('WaveSpeed calls the actual upstream replacement and prompt composition functions', async () => {
  const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
  const between = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
  const sandbox = {
    extensionName: 'st-chatu8',
    extension_settings3: { 'st-chatu8': { prompt_replace_id: 'test', prompt_replace: { test: { text: '白发=替换|silver hair\nrain=后置后|wet street' } } } },
    addLog() {}, extractIfCondition: value => ({ value, condition: null }), safeEvaluateIf: () => true,
  };
  vm.createContext(sandbox);
  vm.runInContext([
    between('function stripChineseAnnotations(text)', 'function blobToDataURL('),
    between('async function zhengmian(', 'async function fumian('),
    between('function parseReWrapper(', 'function getRequestHeaders('),
  ].join('\n'), sandbox);
  const config = { ...DEFAULT_CONFIG, dimensionSource: 'request', fixedPrompt: 'illustration', fixedPromptEnd: 'soft light' };
  const reads = [];
  const adapter = createWaveSpeedAdapter({ replacePrompt: sandbox.prompt_replace, composePrompt: sandbox.zhengmian,
    context: () => ({ chatId: 'chat-a' }), settings: () => ({ mode: 'civitai' }),
    api: async (route, body) => { assert.equal(body, undefined, 'copy must never save settings or submit generation'); reads.push(route); if (route === '/jobs') return []; assert.equal(route, '/config'); return config; },
  });
  const request = { prompt: '白发 traveler in the rain（无须画出的注释）', width: 768, height: 1024 };
  const prepared = await adapter.prepare(request, config);
  assert.equal(prepared.prompt, 'illustration, silver hair traveler in the rain, soft light, wet street');
  assert.equal(prepared.params.size, '768*1024');
  assert.deepEqual(await adapter.promptForCopy(request), { text: prepared.prompt });
  assert.deepEqual(reads, ['/jobs', '/config']);
});

test('copy retrieves the latest matching failed task, across reloads, without regenerating its prompt', async () => {
  const chatId = JSON.stringify(['character.png', 'chat-a']);
  const original = '白发 traveler';
  const job = { source: { chatId }, cacheTag: original, change: 'edited traveler', prompt: 'old preset, silver hair traveler, soft light', status: 'download_failed', createdAt: 10 };
  const history = [
    { ...job, source: { chatId: 'another-chat' }, createdAt: 100, prompt: 'wrong chat' },
    { ...job, cacheTag: 'another image', createdAt: 90, prompt: 'wrong image' },
    { ...job, change: 'another edit', createdAt: 80, prompt: 'wrong edit' },
    { ...job, createdAt: 1, prompt: 'older attempt' }, job,
  ];
  const reads = [];
  const adapter = createWaveSpeedAdapter({
    context: () => ({ characters: [{ avatar: 'character.png' }], characterId: 0, getCurrentChatId: () => 'chat-a' }),
    settings: () => ({ mode: 'civitai' }),
    api: async (route, body) => { assert.equal(body, undefined); assert.equal(route, '/jobs'); reads.push(route); return history; },
    replacePrompt: () => { throw Error('Changed presets must not rewrite a failed task'); },
  });
  assert.deepEqual(await adapter.promptForCopy({ prompt: original, change: job.change }), { text: job.prompt, actual: true });
  assert.deepEqual(reads, ['/jobs']);
});

test('copy still returns the edited original when browser task storage is unavailable', async () => {
  const adapter = createWaveSpeedAdapter({ context: () => ({ chatId: 'chat-a' }),
    api: async () => { throw Error('Storage unavailable'); },
  });
  assert.deepEqual(await adapter.promptForCopy({ prompt: 'original', change: 'edited\nsecond line' }), { text: 'edited\nsecond line', fallback: true });
});
