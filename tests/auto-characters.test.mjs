import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { autoCharacterState, autoCharacterInstruction, withAutoCharacterPrompt, createAutoCharacterControls } from '../wavespeed/auto-characters.js';
import { fixture as characterFixture } from './character-presets-fixture.mjs';
import { fixture, fn } from './llm-compat-fixture.mjs';

test('automatic instructions follow the active saved cast, deduplicate entries and retain aliases', () => {
  const { settings } = characterFixture();
  settings.characterEnablePresets.cast.autoPromptEnabled = true;
  settings.characterEnablePresets.cast.characters.push('hero', 'missing', null);
  const state = autoCharacterState(settings);
  assert.deepEqual(state.characters.map(c => c.name), ['示例男主', '示例女主']);
  assert.deepEqual(state.characters[0].aliases, ['Example Hero', 'Alias']);
  const instruction = autoCharacterInstruction(settings, 'image_gen');
  assert.match(instruction, /未出场的角色不要加入/);
  assert.match(instruction, /不是出场名单/);
  assert.match(instruction, /保留既有回复结构/);
  settings.characterEnablePresets.second = { characters: ['driver'] };
  settings.characterEnablePresetId = 'second';
  assert.equal(autoCharacterInstruction(settings, 'image_gen'), '');
  settings.characterEnablePresets.second.autoPromptEnabled = true;
  assert.doesNotMatch(autoCharacterInstruction(settings, 'image_gen'), /示例男主/);
});

test('off, missing or empty cast and unrelated requests leave messages untouched', () => {
  const { settings } = characterFixture();
  const messages = [{ role: 'user', content: 'a landscape' }];
  assert.equal(withAutoCharacterPrompt(messages, settings, 'image_gen'), messages);
  settings.characterEnablePresets.cast.autoPromptEnabled = true;
  for (const type of ['translation', 'char_design', 'char_modify', 'chat', 'video_gen', undefined]) {
    assert.equal(withAutoCharacterPrompt(messages, settings, type), messages);
  }
  for (const type of ['image_gen', 'char_display', 'tag_modify']) assert.equal(withAutoCharacterPrompt(messages, settings, type).length, 2);
  settings.characterEnablePresets.cast.characters = ['missing'];
  assert.equal(withAutoCharacterPrompt(messages, settings, 'image_gen'), messages);
  assert.equal(withAutoCharacterPrompt(messages, {}, 'image_gen'), messages);
});

test('per-request injection preserves multimodal inputs and does not accumulate across retries', () => {
  const { settings } = characterFixture(); settings.characterEnablePresets.cast.autoPromptEnabled = true;
  const messages = [{ role: 'system', content: 'format' }, { role: 'user', content: [{ type: 'text', text: 'scene' }, { type: 'image_url', image_url: { url: 'https://fixture.invalid/image' } }] }];
  const before = structuredClone(messages);
  const first = withAutoCharacterPrompt(messages, settings, 'image_gen');
  const second = withAutoCharacterPrompt(messages, settings, 'image_gen');
  assert.deepEqual(messages, before); assert.deepEqual(first, second); assert.equal(first.length, 3);
  assert.deepEqual(first.slice(0, -1), messages);
  settings.characterEnablePresets.cast.autoPromptEnabled = false;
  assert.equal(withAutoCharacterPrompt(messages, settings, 'image_gen'), messages);
});

test('suggested tokens resolve through the actual preset hook and preserve the scene', async () => {
  const { settings, productionAdapter } = characterFixture();
  settings.characterEnablePresets.cast.autoPromptEnabled = true;
  const [hero, driver] = autoCharacterState(settings).characters;
  const prepared = await productionAdapter().prepare({ prompt: `A car cabin. ${hero.token}, white shirt, seated. ${driver.token}, driving.` }, { provider: 'civitai', imageModel: 'urn:air:krea2:diffusionmodel:civitai:100@200', imageParams: { width: 1024, height: 1024 } });
  assert.match(prepared.prompt, /refined face, short black hair/);
  assert.match(prepared.prompt, /gold rimmed glasses/);
  assert.match(prepared.prompt, /white shirt, seated/);
  assert.doesNotMatch(prepared.prompt, /\$/);
  const landscape = await productionAdapter().prepare({ prompt: 'An empty car cabin at dusk.' }, { provider: 'civitai', imageModel: 'urn:air:krea2:diffusionmodel:civitai:100@200', imageParams: {} });
  assert.equal(landscape.prompt, 'An empty car cabin at dusk.');
});

test('the production switch saves unsaved cast edits before enabling and persists across reload', async () => {
  const { settings } = characterFixture();
  const roots = Array.from({ length: 2 }, () => {
    const button = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(_type, fn) { this.click = fn; } }, status = {};
    return { button, status, querySelector: selector => selector === 'button' ? button : status };
  });
  let stored, prepares = 0;
  const controls = createAutoCharacterControls({ settings: () => settings, save: () => { stored = JSON.stringify(settings); }, prepare: () => { prepares++; settings.characterEnablePresets.cast.characters = ['hero']; }, document: { querySelectorAll: () => roots } });
  controls.refresh(); controls.refresh();
  await roots[0].button.click();
  assert.equal(prepares, 1); assert.equal(JSON.parse(stored).characterEnablePresets.cast.autoPromptEnabled, true);
  assert.equal(roots[1].button.attrs['aria-pressed'], 'true'); assert.match(roots[1].status.textContent, /示例男主/);
  assert.equal(autoCharacterState(JSON.parse(stored)).enabled, true);
  await roots[1].button.click();
  assert.equal(prepares, 1); assert.equal(roots[0].button.attrs['aria-pressed'], 'false');
  assert.equal(autoCharacterState(JSON.parse(stored)).enabled, false);
});

test('empty casts and save failures cannot falsely show successful activation', async () => {
  const { settings } = characterFixture(); const notices = [];
  const button = { setAttribute() {}, addEventListener(_type, fn) { this.click = fn; } }, status = {};
  const controls = createAutoCharacterControls({ settings: () => settings, save: () => { throw Error('test save failure'); }, notify: (message, warning) => notices.push({ message, warning }), document: { querySelectorAll: () => [{ querySelector: selector => selector === 'button' ? button : status }] } });
  controls.refresh(); await button.click();
  assert.equal(autoCharacterState(settings).enabled, false); assert.match(notices.at(-1).message, /未保存/);
  settings.characterEnablePresets.cast.characters = []; controls.refresh(); await button.click();
  assert.equal(autoCharacterState(settings).enabled, false); assert.match(notices.at(-1).message, /加入列表/);
  assert.equal(button.disabled, false);
});

test('actual typed service refreshes the cast between requests and retries without duplicating instructions', async () => {
  const { settings } = characterFixture(); settings.characterEnablePresets.cast.autoPromptEnabled = true;
  settings.llm_retry_count = 1;
  const { box } = fixture(settings), sent = [], events = [];
  let calls = 0;
  Object.assign(box, {
    AbortController, TextDecoder, setTimeout: callback => setTimeout(callback, 0), clearTimeout,
    activeRequests: new Map(), llmTaskControllers: new Map(), REQUEST_TYPE_NAMES: {}, TaskType: { LLM: 'llm' }, TaskStatus: { RUNNING: 'running' },
    generateRequestKey: () => 'request', getEffectiveConfigForRequestType: () => ({ api_url: 'https://fixture.invalid/v1', api_key: 'fake', model: 'test', bypass_proxy: true, enable_custom_body_params: true, custom_body_params: '{}' }),
    parseCustomBody: () => ({}), taskQueue: { addTask: () => 'task', updateStatus() {}, completeTask() {} }, acquireFabLoading() {}, releaseFabLoading() {},
    formatPromptForDisplay: () => '', countImageParts: () => 0, addLog() {}, parseCustomHeaders: () => ({}), isEmptyResponse: text => !text, shouldApplyAiReplacement: () => false,
    isNonRetryableError: () => false, shouldRetryError: () => true, toastr: { warning() {}, error() {} }, eventSource6: { emit: (_event, data) => events.push(data) },
    fetch: async (_url, options) => { sent.push(JSON.parse(options.body)); if (++calls === 1) throw Error('temporary fixture failure'); return new Response(JSON.stringify({ choices: [{ message: { content: 'image###landscape###' } }] })); }
  });
  vm.runInContext(fn('stripImagesFromMessages') + '\n' + fn('executeTypedLLMRequest'), box);
  const prompt = [{ role: 'user', content: 'scene' }];
  await box.executeTypedLLMRequest({ id: 'test-first', prompt }, 'image_gen', 'done');
  assert.equal(sent.length, 2); assert.equal(events.at(-1).success, true);
  for (const body of sent) assert.equal(JSON.stringify(body.messages).split('【固定角色外貌 · 自动要求】').length - 1, 1);
  settings.characterEnablePresets.cast.autoPromptEnabled = false;
  await box.executeTypedLLMRequest({ id: 'test-off', prompt }, 'image_gen', 'done');
  assert.doesNotMatch(JSON.stringify(sent.at(-1)), /固定角色外貌/);
  assert.deepEqual(prompt, [{ role: 'user', content: 'scene' }]);
});
