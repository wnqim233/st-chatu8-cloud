import fs from 'node:fs/promises';
import vm from 'node:vm';

export const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
export function moduleSource(name) {
  const marker = '// ' + name + '\n', start = source.lastIndexOf(marker);
  if (start < 0) throw Error('Missing module: ' + name);
  const next = /^\/\/ [a-zA-Z][^\n]*\.(?:js|ts)\s*$/m.exec(source.slice(start + marker.length));
  return source.slice(start, next ? start + marker.length + next.index : source.length);
}
export function fn(name) {
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(source);
  if (!match) throw Error('Missing function: ' + name);
  return source.slice(match.index, source.indexOf('\n}', match.index) + 2);
}
export function fixture(settings = {}) {
  const ctx = { chatMetadata: { variables: { appearance: 'silver hair', character: { eyes: 'blue eyes' }, nested: '{{getvar::appearance}}', zero: 0 } } };
  const globals = { lighting: 'soft light' }, world = { weather: 'rain', zero: 0 };
  const box = {
    console: { log() {}, warn() {}, error() {} }, extensionName: 'st-chatu8-cloud',
    extension_settings15: { 'st-chatu8-cloud': settings }, extension_settings16: { 'st-chatu8-cloud': settings }, extension_settings17: { 'st-chatu8-cloud': settings },
    __esm(def) { let done = false; return () => { if (!done) { done = true; Object.values(def)[0](); } }; },
    getContext4: () => ctx, init_config() {}, init_chatDataUtils() {}, init_worldbookProcessor() {}, init_wordReplacementService() {}, init_videoAssetsService() {}, init_defaultToolCallConfig() {},
    defaultToolCallConfig: { enabled: false }, defaultTailMessagesConfig: { enabled: false },
    resolveNestedVariable: (vars, path) => path.split('.').reduce((value, key) => value?.[key], vars),
    setNestedVariable: (vars, path, value) => { const keys = path.split('.'); for (const key of keys.slice(0, -1)) vars = vars[key] ||= {}; vars[keys.at(-1)] = value; },
    setglobalvar: (key, value) => { globals[key] = value; }, resolveGlobalVariable: key => globals[key], getworldvar: key => world[key],
    getMergeOptionsForRequestType: () => ({}), processRollPlaceholders: messages => messages,
  };
  vm.createContext(box);
  vm.runInContext(['utils/promptProcessor.js', 'utils/settings/linuxTerminalImageData.js', 'utils/settings/toolCallService.js', 'utils/settings/toolCallDecoder.js', 'utils/aiThinkingParser.js'].map(moduleSource).join('\n') + '\n' +
    ['buildPromptForRequestType', 'removeThinkBlocks', 'stripThinkingForPregen'].map(fn).join('\n') + '\ninit_toolCallService(); init_toolCallDecoder();', box, { timeout: 2000 });
  return { box, ctx, settings };
}
