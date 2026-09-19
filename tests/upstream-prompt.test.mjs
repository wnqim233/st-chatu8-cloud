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
    between('async function prompt_replace(', 'async function prompt_replace_banana('),
  ].join('\n'), sandbox);
  const adapter = createWaveSpeedAdapter({ replacePrompt: sandbox.prompt_replace, composePrompt: sandbox.zhengmian });
  const prepared = await adapter.prepare({ prompt: '白发 traveler in the rain（无须画出的注释）', width: 768, height: 1024 }, { ...DEFAULT_CONFIG, fixedPrompt: 'illustration', fixedPromptEnd: 'soft light' });
  assert.equal(prepared.prompt, 'illustration, silver hair traveler in the rain, soft light, wet street');
  assert.equal(prepared.params.size, '768*1024');
});
