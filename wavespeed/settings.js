/* Cloud settings editor. Aladdin Free Public License; see ../LICENSE. */
import { portableConfig, plainObject } from '../shared/config.js';
import { providerConfig } from './client.js';

const fields = {
  civitai: { 'civitai-model': 'civitaiModel', 'civitai-buzz': 'civitaiMaxBuzz' },
  wavespeed: { model: 'imageModel', 'size-mode': 'sizeMode', 'negative-field': 'negativeField' },
  shared: { prefix: 'fixedPrompt', suffix: 'fixedPromptEnd', negative: 'negativePrompt', 'dimension-source': 'dimensionSource' },
};
const names = { civitai: 'Civitai', wavespeed: 'WaveSpeed' };
const keyIds = provider => provider === 'civitai' ? ['civitai-key', 'civitai-clear-key', 'civitaiKey'] : ['key', 'clear-key', 'wavespeedKey'];
const paramsId = provider => provider === 'civitai' ? 'civitai-params' : 'params';
export function parameterSummary(params) {
  const size = params.width && params.height ? `${params.width} × ${params.height}` : params.size || '模型默认尺寸';
  const loras = params.loras || params.additionalNetworks || {};
  return `${size} · ${params.steps ?? '默认'} 步 · CFG ${params.cfgScale ?? '默认'} · LoRA ${Object.keys(loras).length} 个`;
}
export function loraSummary(params) {
  const entries = Object.entries(params.loras || params.additionalNetworks || {});
  return entries.length ? entries.map(([air, value]) => `${air.split(':').pop()} → ${typeof value === 'object' ? value.strength ?? '默认' : value}`).join('\n') : '未挂载 LoRA';
}

export function createSettingsEditor({ api, deps, $, notify, onModeChanged }) {
  let root, saved, editing, loading, saving, saveError = '';
  const dirty = new Set();
  const mode = () => deps.settings().mode;
  const changed = provider => dirty.has(provider) || dirty.has('shared');
  function state() {
    if (!root || !saved) return;
    $('active').textContent = `当前生图：${names[mode()] || '其他后端'}`;
    for (const [provider, id] of [['civitai', 'civitai-use'], ['wavespeed', 'use']]) {
      $(`${provider}-panel`).hidden = editing !== provider;
      $(id).setAttribute('aria-pressed', String(editing === provider));
      $(id).textContent = names[provider] + (dirty.has(provider) ? ' · 未保存' : '');
    }
    $('save').textContent = '保存并使用';
    const savedText = `已保存${saved.savedAt ? ' · '+new Date(saved.savedAt).toLocaleTimeString() : ''} · 配置 #${saved.revision || 0}`;
    const status = provider => saving ? '正在保存…' : saveError || (changed(provider) ? '有修改未保存' : savedText);
    $('save-state').textContent = status(editing);
    $('save-state').dataset.dirty = String(changed(editing));
    $('save').disabled = Boolean(saving || loading);
    $('form').disabled = Boolean(saving || loading);
    for (const button of root.querySelectorAll('[data-ws-save]')) button.disabled = Boolean(saving || loading);
    for (const item of root.querySelectorAll('[data-ws-save-state]')) {
      item.textContent = status(item.dataset.wsSaveState);
      item.dataset.error = String(Boolean(saveError));
    }
    const cfg = providerConfig(saved, editing);
    $('saved-summary').textContent = `${names[editing]} · ${parameterSummary(cfg.imageParams)}\nLoRA：\n${loraSummary(cfg.imageParams)}`;
    $('saved-params').textContent = JSON.stringify({ model: cfg.imageModel, params: cfg.imageParams }, null, 2);
    $('dimension-hint').textContent = $('dimension-source').value === 'json' ? '按 JSON 时，正文按钮的宽高不会覆盖参数。' : '正文按钮带有宽高时会覆盖 JSON；没有宽高时仍用 JSON。';
  }
  function fill(config, provider) {
    saveError = '';
    for (const group of provider ? [provider, 'shared'] : ['civitai', 'wavespeed', 'shared']) {
      for (const [id, key] of Object.entries(fields[group])) $(id).value = config[key] ?? (key === 'dimensionSource' ? 'json' : '');
      dirty.delete(group);
      if (group === 'shared') continue;
      $(paramsId(group)).value = JSON.stringify(group === 'civitai' ? config.civitaiParams : config.imageParams, null, 2);
      const [keyId, clearId] = keyIds(group); $(keyId).value = ''; $(clearId).checked = false;
      const hasKey = group === 'civitai' ? config.hasCivitaiKey : config.hasWavespeedKey;
      $(keyId).placeholder = hasKey ? '已保存；留空保留原 Key' : '尚未配置 API Key';
      $(`${keyId}-state`).textContent = hasKey ? '已保存' : '未配置';
    }
    saved = config;
    // Keep the original per-provider resolution popup in sync as a convenience.
    for (const provider of ['civitai', 'wavespeed']) {
      const p = providerConfig(config, provider).imageParams;
      const size = String(p.size || '').match(/^(\d+)\*(\d+)$/);
      deps.settings()[`${provider}_width`] = Number(size?.[1] || p.width || 1024);
      deps.settings()[`${provider}_height`] = Number(size?.[2] || p.height || 1024);
    }
    state();
  }
  function parse(provider) {
    let params;
    try { params = JSON.parse($(paramsId(provider)).value); } catch { throw new Error(`${names[provider]} JSON 格式错误，未保存、未提交。请检查逗号和引号；@ 前不要加反斜杠。`); }
    if (!plainObject(params)) throw new Error(`${names[provider]} 参数必须是 JSON 对象。`);
    return params;
  }
  function payload(provider) {
    const result = {};
    for (const group of [provider, 'shared']) for (const [id, key] of Object.entries(fields[group])) result[key] = key === 'civitaiMaxBuzz' ? Number($(id).value) : $(id).value.trim();
    result[provider === 'civitai' ? 'civitaiParams' : 'imageParams'] = parse(provider);
    const [keyId, clearId, key] = keyIds(provider);
    result[key] = $(keyId).value.trim(); result[`clear_${key}`] = $(clearId).checked;
    return result;
  }
  async function load() {
    if (loading) return loading;
    const target = root;
    loading = (async () => { const config = await api('/config'); if (target !== root) return; fill(config); notify('配置已读取。选择平台编辑，保存后对新任务生效。'); })();
    try { await loading; } finally { loading = undefined; state(); }
  }
  function activate(provider) {
    deps.settings().mode = provider;
    const select = globalThis.document?.getElementById('mode');
    if (select) { select.value = provider; globalThis.jQuery?.(select).trigger('change'); }
    deps.saveSettings(); onModeChanged();
  }
  async function save(provider = editing, { use = true } = {}) {
    if (loading) await loading;
    if (!saved) throw new Error('尚未成功读取配置，请先重新读取。');
    if (saving) { await saving; if (!changed(provider)) { if (use) activate(provider); state(); return saved; } }
    saveError = '';
    let input;
    try { input = payload(provider); } // Only the selected backend is parsed/saved.
    catch (error) { saveError = error.message; dirty.add(provider); state(); throw error; }
    saving = (async () => {
      const written = await api('/config', input);
      const readback = await api('/config');
      for (const key of Object.keys(portableConfig(input))) if (JSON.stringify(readback[key]) !== JSON.stringify(written[key])) throw new Error('保存后配置被其他页面修改，请重新读取核对；未提交生图。');
      fill(readback, provider);
      if (use) activate(provider); else deps.saveSettings();
      notify(`${names[provider]} 已保存并核对 · 配置 #${readback.revision || 0}。新任务使用这组 LoRA；已排队任务保留入队时参数。`);
      return readback;
    })();
    state();
    try { return await saving; }
    catch (error) { saveError = error.message; dirty.add(provider); notify(error.message, true); throw error; }
    finally { saving = undefined; state(); }
  }
  function mount() {
    const next = $('form'); if (!next || root === next) return;
    root = next; saved = undefined; saveError = ''; dirty.clear(); editing = names[mode()] ? mode() : 'civitai';
    const edit = event => { if (!saved || event.target.id === 'ws-civitai-preview') return; saveError = ''; dirty.add(event.target.closest('[data-ws-provider]')?.dataset.wsProvider || 'shared'); state(); };
    root.addEventListener('input', edit); root.addEventListener('change', edit);
    const actions = { save: () => save(), load: () => {
      if (dirty.size && !globalThis.confirm('重新读取会放弃当前未保存的修改，是否继续？')) return;
      return load();
    }, use: () => { editing = 'wavespeed'; state(); }, 'civitai-use': () => { editing = 'civitai'; state(); },
    format: () => format('wavespeed'), 'civitai-format': () => format('civitai') };
    for (const [id, action] of Object.entries(actions)) $(id).addEventListener('click', () => Promise.resolve().then(action).catch(error => notify(error.message, true)));
    for (const button of root.querySelectorAll('[data-ws-save]')) button.addEventListener('click', () => save(button.dataset.wsSave).catch(error => notify(error.message, true)));
    void load().catch(error => { notify(error.message, true); $('save-state').textContent = '读取失败，请重新读取'; });
  }
  function format(provider) { $(paramsId(provider)).value = JSON.stringify(parse(provider), null, 2); dirty.add(provider); state(); }
  return { mount, save, state,
    async forGeneration(provider) {
      if (loading) await loading;
      if (saving) await saving;
      if (root?.isConnected && changed(provider)) await save(provider, { use: false });
      return api('/config');
    },
    async exportConfig() {
      if (loading) await loading;
      if (saving) await saving;
      if (root?.isConnected) for (const provider of ['civitai', 'wavespeed']) if (changed(provider)) await save(provider, { use: false });
      return { version: 1, config: portableConfig(await api('/config')) };
    },
    imported(config) { if (root?.isConnected) fill(config); },
  };
}
