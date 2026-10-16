// Attach the actual bundled preset controls to the full settings browser fixture.
import { createWaveSpeedAdapter } from '/wavespeed/adapter.js';
import { createSettingsEditor } from '/wavespeed/settings.js';
import { createBrowserApi } from '/wavespeed/browser.js';
import { DEFAULT_CONFIG } from '/shared/config.js';
import { providerConfig } from '/wavespeed/client.js';

const { settings, source, fn, settingsModal, api: navigation, click } = globalThis.regression;
const storageKey = 'cloud-prompt-replace-fixture';
Object.assign(settings, JSON.parse(localStorage.getItem(storageKey) || JSON.stringify({
  prompt_replace_id: '旧规则',
  prompt_replace: { 默认: { text: '' }, 旧规则: { text: '白发=替换|silver hair' } },
})), { mode: 'civitai' });
const inputs = [], confirmations = [], alerts = [];
const codeStart = source.lastIndexOf('// utils/settings/prompt_replace.js\n');
const codeEnd = source.indexOf('\n// utils/settings/log.js', codeStart);
const code = source.slice(codeStart, codeEnd);
const rulesStart = source.indexOf('function parseReWrapper(');
const rules = source.slice(rulesStart, source.indexOf('function getRequestHeaders(', rulesStart));
const composeStart = source.indexOf('async function zhengmian(');
const compose = source.slice(composeStart, source.indexOf('async function fumian(', composeStart));
const context = {
  extensionName: 'st-chatu8-cloud',
  extension_settings63: { 'st-chatu8-cloud': settings },
  extension_settings3: { 'st-chatu8-cloud': settings },
  init_config() {}, init_ui_common() {}, addLog() {},
  saveSettingsDebounced38() {
    localStorage.setItem(storageKey, JSON.stringify({ prompt_replace: settings.prompt_replace, prompt_replace_id: settings.prompt_replace_id }));
  },
  stylishConfirm: async () => confirmations.length ? confirmations.shift() : true,
  stylInput: async () => inputs.shift() || '',
  alert: value => alerts.push(value),
  extractIfCondition: value => ({ value, condition: null }), safeEvaluateIf: () => true,
};
const actual = Function(...Object.keys(context), fn('getSuffix') + '\n' + fn('stripChineseAnnotations') + '\n' + rules + '\n' + compose + '\n' + code +
  '\nreturn { refreshPromptReplacePresets, initPromptReplaceControls, prompt_replace, prompt_replace_for_character, zhengmian };')(...Object.values(context));
actual.refreshPromptReplacePresets();
actual.initPromptReplaceControls(settingsModal);
navigation.updateModeNavVisibility(settingsModal);
click('wavespeed');
document.getElementById('ch-version-display').textContent = 'v' + (await (await fetch('/manifest.json')).json()).version;
const browserApi = createBrowserApi({ settings: () => settings, saveSettings() {} }, {
  fetcher: () => { throw Error('External provider request forbidden in this fixture'); },
});
const editor = createSettingsEditor({ api: browserApi, deps: { settings: () => settings, saveSettings() {} },
  $: id => document.getElementById('ws-' + id), notify() {}, onModeChanged() {} });
editor.mount();
const adapter = createWaveSpeedAdapter({ replacePrompt: actual.prompt_replace,
  replaceCharacter: actual.prompt_replace_for_character, composePrompt: actual.zhengmian });
globalThis.cloudReplace = {
  ready: true, settings, inputs, confirmations, alerts,
  refresh: actual.refreshPromptReplacePresets,
  saved: () => JSON.parse(localStorage.getItem(storageKey) || 'null'),
  async prepare(provider, prompt) {
    return adapter.prepare({ prompt }, providerConfig({ ...DEFAULT_CONFIG, fixedPrompt: '', fixedPromptEnd: '', negativePrompt: '' }, provider));
  },
};
