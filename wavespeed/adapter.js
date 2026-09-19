/* Added by Codex for the workspace owner, 2026-09-19.
 * Reuses upstream st-chatu8 generation events, prompt helpers, queue and cache.
 * Aladdin Free Public License; see ../LICENSE.
 */
import { makeId, imagePath, mapParameters, providerConfig, waitForJob, readLocalImage, LABELS } from './client.js';
import { createBrowserApi } from './browser.js';
import { ACTIVE, queuedJobs } from '../shared/jobs.js';
import { portableConfig } from '../shared/config.js';

export function createWaveSpeedAdapter(deps) {
  const api = deps.api || createBrowserApi(deps);
  const readImage = deps.readImage || readLocalImage;
  const wait = deps.wait || waitForJob;
  let listening = false;
  let mounted = false;
  let models = [];
  let jobs = [];
  let workerTimer;
  let workerRunning = false;
  let cancelListening = false;
  const cloudTasks = new Map();
  const inFlight = new Set();
  const restoring = new Map();
  const $ = name => globalThis.document?.getElementById(`ws-${name}`);
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
  const notify = (text, error = false) => { if ($('status')) { $('status').textContent = text; $('status').dataset.error = String(error); } };

  async function prepare(request, config) {
    const original = request.change?.trim() || request.prompt;
    if (/\{(?:视频|修图|局部重绘)\}/.test(original || '')) throw new Error('当前接口是文生图；请切换原插件的编辑或视频后端处理此请求。');
    let main = original;
    let other = '';
    let roles;
    if (original?.includes('Scene Composition')) {
      roles = deps.parseRoles(original);
      main = roles['Scene Composition'] || original;
      other = [1, 2, 3, 4].map(i => roles[`Character ${i} Prompt`] || '').join(', ');
    }
    const { modifiedPrompt, insertions } = await deps.replacePrompt(main, other);
    let replaced = modifiedPrompt;
    if (roles) for (let i = 1; i <= 4; i++) if (roles[`Character ${i} Prompt`]) replaced += ` | ${deps.replaceCharacter(roles[`Character ${i} Prompt`], `${main} ${other}`)}`;
    const prompt = await deps.composePrompt(config.fixedPrompt, replaced, config.fixedPromptEnd, '', insertions);
    const negative = [config.negativePrompt, request.negative_prompt].filter(Boolean).join(', ');
    return { prompt, params: mapParameters(config, request, negative) };
  }

  async function restore(job, force = false) {
    if (job.status !== 'completed') throw new Error('图片还未生成完成。');
    if (restoring.has(job.id)) return restoring.get(job.id);
    const work = (async () => {
      if (!imagePath(job.images?.[0])) throw new Error('任务没有有效的本地图片。');
      const image = await readImage(job.images[0]);
      const saved = deps.settings().wavespeedRestoredJobs || [];
      if ((force || String(deps.settings().cache) !== '0') && !saved.includes(job.id)) {
        const format = job.formats?.[0] || job.images[0].split('.').pop();
        await deps.cacheImage(job.cacheTag || job.prompt, image, {
          change: job.change || '', format, isVideo: false, originalUrl: job.images[0].startsWith('blob:') ? '' : job.images[0],
          // Wait for persistence before recording that recovery succeeded.
          __tailRun: true,
          genParams: { backend: job.provider === 'civitai' ? 'Civitai' : 'WaveSpeed', model: job.model, resolvedPrompt: job.prompt, ...job.params, ...(job.seed !== undefined ? { seed: job.seed } : {}) },
        });
        deps.settings().wavespeedRestoredJobs = [...new Set([...(deps.settings().wavespeedRestoredJobs || []), job.id])].slice(-200);
        deps.saveSettings();
      }
      return image;
    })();
    restoring.set(job.id, work);
    try { return await work; } finally { restoring.delete(job.id); }
  }

  function remember(job) {
    jobs = [job, ...jobs.filter(j => j.id !== job.id)].sort((a, b) => b.createdAt - a.createdAt);
    renderJobs();
  }

  async function generate(request) {
    if (!request?.id || inFlight.has(request.id)) return;
    inFlight.add(request.id);
    const provider = deps.settings().mode === 'civitai' ? 'civitai' : 'wavespeed';
    const label = provider === 'civitai' ? 'Civitai' : 'WaveSpeed';
    let taskId;
    let taskState;
    try {
      const ctx = deps.context();
      const chatId = JSON.stringify([ctx.groupId ?? ctx.characters?.[ctx.characterId]?.avatar ?? 'chat', ctx.getCurrentChatId?.() ?? ctx.chatId ?? 'manual']);
      taskId = deps.taskQueue.addTask({ name: `${label} 生图`, type: provider, prompt: request.prompt });
      taskState = { job: null, cancelled: false, status: 'queued' };
      cloudTasks.set(taskId, taskState);
      const config = providerConfig(await api('/config'), provider);
      const { prompt, params } = await prepare(request, config);
      if (taskState.cancelled) throw new Error('已取消排队，未向平台提交。');
      let first = await api('/jobs', {
        id: makeId(), provider, prompt, params, model: config.imageModel, cacheTag: request.prompt, change: request.change || '',
        source: { chatId, messageId: String(request.id).slice(0, 100), swipeId: 0, hash: String(request.id).slice(0, 100) },
      });
      taskState.job = first;
      if (taskState.cancelled && first.status === 'queued') first = await api(`/jobs/${first.id}/cancel`, {});
      const job = await wait(api, first, { onUpdate: job => {
        taskState.job = job;
        const status = job.status === 'queued' ? 'queued' : job.status === 'cancelled' ? 'cancelled' : 'running';
        if (taskState.status !== status) { deps.taskQueue.updateStatus(taskId, status); taskState.status = status; }
        remember(job);
      } });
      const image = await restore(job);
      deps.taskQueue.completeTask(taskId, true);
      deps.record(provider, true);
      deps.events.emit(deps.eventTypes.GENERATE_IMAGE_RESPONSE, {
        id: request.id, success: true, imageData: image, prompt: request.prompt, change: request.change || '',
        isVideo: false, format: job.formats?.[0] || job.images[0].split('.').pop(), originalUrl: job.images[0].startsWith('blob:') ? '' : job.images[0],
      });
      deps.log(`[${label}] 图片已生成并保存，任务 ID: ${job.taskId}`);
    } catch (error) {
      if (taskId) {
        if (taskState?.job?.status === 'cancelled' || taskState?.cancelled && !taskState.job) deps.taskQueue.updateStatus(taskId, 'cancelled');
        else deps.taskQueue.completeTask(taskId, false);
      }
      deps.record(provider, false);
      deps.events.emit(deps.eventTypes.GENERATE_IMAGE_RESPONSE, { id: request.id, success: false, error: error.message, prompt: request.prompt, change: request.change || '' });
      deps.log(`[${label}] ${error.message}`);
    } finally { inFlight.delete(request.id); cloudTasks.delete(taskId); }
  }

  function updateMode() {
    const enabled = deps.enabled() && ['wavespeed', 'civitai'].includes(deps.settings().mode);
    if (enabled && !listening) { deps.events.on(deps.eventTypes.GENERATE_IMAGE_REQUEST, generate); listening = true; }
    else if (!enabled && listening) { deps.events.removeListener(deps.eventTypes.GENERATE_IMAGE_REQUEST, generate); listening = false; }
    if (enabled && !cancelListening) { deps.events.on('st_chatu8_task_cancelled', cancelTask); cancelListening = true; }
    if (enabled) { deps.initializeImages(); scheduleWorker(); }
    else if (workerTimer) { clearTimeout(workerTimer); workerTimer = undefined; }
  }

  async function cancelTask({ taskId }) {
    const state = cloudTasks.get(taskId);
    if (!state) return;
    state.cancelled = true;
    if (!state.job) return;
    try {
      const job = await api(`/jobs/${state.job.id}/cancel`, {});
      state.job = job; remember(job);
    } catch (error) {
      state.cancelled = false;
      deps.taskQueue.updateStatus(taskId, 'running'); notify(error.message, true);
    }
  }

  function scheduleWorker() {
    if (workerTimer || workerRunning || !globalThis.document) return;
    workerTimer = setTimeout(async () => {
      workerTimer = undefined; workerRunning = true;
      try {
        jobs = await api('/jobs/tick', {}); renderJobs();
        // Reopened pages no longer have the original event waiter. Restore new
        // completed queue jobs through the same upstream image cache.
        for (const job of jobs) if (job.queueOrder !== undefined && job.status === 'completed' && String(deps.settings().cache) !== '0' && !(deps.settings().wavespeedRestoredJobs || []).includes(job.id)) {
          try { await restore(job); } catch (error) { notify(error.message, true); }
        }
      } catch (error) { notify(error.message, true); }
      finally {
        workerRunning = false;
        if (deps.enabled() && ['wavespeed', 'civitai'].includes(deps.settings().mode)) scheduleWorker();
      }
    }, 3000);
  }

  function fill(config) {
    $('model').value = config.imageModel; $('params').value = JSON.stringify(config.imageParams, null, 2);
    $('prefix').value = config.fixedPrompt; $('suffix').value = config.fixedPromptEnd; $('negative').value = config.negativePrompt;
    $('size-mode').value = config.sizeMode; $('negative-field').value = config.negativeField;
    $('key').value = ''; $('clear-key').checked = false;
    $('key').placeholder = config.hasWavespeedKey ? '已保存；留空保留原 Key' : '尚未配置 WaveSpeed API Key';
    $('civitai-key').value = ''; $('civitai-clear-key').checked = false;
    $('civitai-key').placeholder = config.hasCivitaiKey ? '已保存；留空保留原 Key' : '尚未配置 Civitai API Key';
    $('civitai-model').value = config.civitaiModel;
    $('civitai-params').value = JSON.stringify(config.civitaiParams, null, 2);
    $('civitai-buzz').value = config.civitaiMaxBuzz;
    // The existing image size popup reads the same per-backend keys as other modes.
    const size = String(config.imageParams.size || '').match(/^(\d+)\*(\d+)$/);
    deps.settings().wavespeed_width = Number(size?.[1] || config.imageParams.width || 1024);
    deps.settings().wavespeed_height = Number(size?.[2] || config.imageParams.height || 1024);
    deps.settings().civitai_width = Number(config.civitaiParams.width || 1024);
    deps.settings().civitai_height = Number(config.civitaiParams.height || 1024);
  }

  async function load() { const config = await api('/config'); fill(config); notify('浏览器直连模式已就绪，无需服务端插件。LLM 与世界书继续使用原插件设置。'); }
  async function save() {
    let params, civitaiParams;
    try { params = JSON.parse($('params').value); civitaiParams = JSON.parse($('civitai-params').value); } catch { throw new Error('模型参数不是有效的 JSON。'); }
    const config = await api('/config', { wavespeedKey: $('key').value.trim(), clear_wavespeedKey: $('clear-key').checked, imageModel: $('model').value.trim(), imageParams: params, civitaiKey: $('civitai-key').value.trim(), clear_civitaiKey: $('civitai-clear-key').checked, civitaiModel: $('civitai-model').value.trim(), civitaiParams, civitaiMaxBuzz: Number($('civitai-buzz').value), fixedPrompt: $('prefix').value, fixedPromptEnd: $('suffix').value, negativePrompt: $('negative').value, sizeMode: $('size-mode').value, negativeField: $('negative-field').value });
    fill(config); deps.saveSettings(); notify('WaveSpeed / Civitai 配置已保存。');
  }
  async function estimate() {
    await save();
    const result = await api('/civitai/estimate', { prompt: $('civitai-preview').value });
    notify(`Civitai 预估 ${result.estimatedBuzz} Buzz，当前上限 ${result.maxBuzz} Buzz。${result.withinLimit ? '在上限内。' : '超过上限，将阻止生成。'}本次仅预估，没有提交付费任务。`);
  }
  function schema() { $('schema').textContent = JSON.stringify(models.find(m => m.id === $('model').value)?.schema || '请先读取模型列表，或查看所选模型文档。', null, 2); }
  async function loadModels() {
    models = await api('/models'); $('model-list').replaceChildren();
    for (const model of models) { const option = node('option'); option.value = model.id; option.label = model.name; $('model-list').append(option); }
    schema(); notify(`已读取 ${models.length} 个文生图模型，Key 验证通过。`);
  }
  async function refreshJobs() {
    jobs = await api('/jobs/tick', {});
    renderJobs(); notify('任务状态已更新；排队任务会在空出名额时自动提交，已提交的任务只查询原任务。');
  }
  function renderJobs() {
    if (!$('jobs')) return;
    const waiting = queuedJobs(jobs);
    if ($('queue-summary')) $('queue-summary').textContent = `进行中 ${jobs.filter(j => ACTIVE.has(j.status)).length}/2 · 等候 ${waiting.length} 张`;
    const container = $('jobs');
    const signature = JSON.stringify(jobs);
    if (container.dataset.signature === signature) return;
    container.dataset.signature = signature; container.replaceChildren();
    if (!jobs.length) container.append(node('p', '暂无生图任务。', 'ws-hint'));
    for (const job of [...waiting, ...jobs.filter(j => j.status !== 'queued')]) {
      const card = node('article', undefined, 'ws-job');
      card.append(node('strong', job.status === 'queued' ? `排队中 · 第 ${waiting.findIndex(j => j.id === job.id) + 1} 位` : LABELS[job.status] || job.status), node('p', `${new Date(job.createdAt).toLocaleString()} · ${job.model}`, 'ws-hint'));
      if (job.taskId) card.append(node('p', `任务 ID：${job.taskId}`, 'ws-hint'));
      if (job.estimatedBuzz !== undefined) card.append(node('p', `Civitai 提交时预估：${job.estimatedBuzz} Buzz`, 'ws-hint'));
      if (job.error) card.append(node('p', job.error, 'ws-status'));
      const details = node('details'); details.append(node('summary', '查看实际绘图提示词'), node('pre', job.prompt, 'ws-code')); card.append(details);
      const images = node('div', undefined, 'ws-images');
      for (const src of job.images || []) if (imagePath(src)) {
        const a = node('a'); a.href = src; a.target = '_blank'; a.rel = 'noopener';
        const image = node('img'); image.src = src; image.alt = '生成图片'; image.loading = 'lazy'; a.append(image); images.append(a);
      }
      card.append(images);
      if (job.status === 'queued') {
        const cancel = node('button', '取消排队', 'menu_button'); cancel.type = 'button';
        cancel.addEventListener('click', () => api(`/jobs/${job.id}/cancel`, {}).then(remember).catch(e => notify(e.message, true)));
        card.append(cancel);
      }
      if (job.status === 'completed') {
        const button = node('button', '放回原插件缓存', 'menu_button'); button.type = 'button';
        button.addEventListener('click', () => restore(job, true).then(() => notify('图片已放回原插件缓存。刷新聊天页面后，原图片标签可加载该图片。')).catch(e => notify(e.message, true)));
        card.append(button);
      }
      if (job.status === 'unknown' || job.status === 'submitting' && Date.now() - (job.startedAt ?? job.createdAt) > 90000) {
        const input = node('input'); input.placeholder = '对应平台历史记录中的任务 ID'; input.setAttribute('aria-label', '恢复任务 ID');
        const button = node('button', '补填 ID，恢复查询', 'menu_button'); button.type = 'button';
        button.addEventListener('click', () => api(`/jobs/${job.id}/recover`, { taskId: input.value.trim() }).then(remember).catch(e => notify(e.message, true)));
        card.append(input, button);
        if (Date.now() - (job.startedAt ?? job.createdAt) > 90000) {
          const dismiss = node('button', '结束本地跟踪', 'menu_button'); dismiss.type = 'button';
          dismiss.addEventListener('click', () => {
            if (window.confirm('请先核对平台历史。结束本地跟踪不会取消平台任务，也不代表退款。确定结束？')) api(`/jobs/${job.id}/dismiss`, {}).then(remember).catch(e => notify(e.message, true));
          }); card.append(dismiss);
        }
      }
      container.append(card);
    }
  }

  function mount() {
    if (mounted || !$('load')) return;
    mounted = true;
    const use = provider => {
      const mode = document.getElementById('mode'); mode.value = provider;
      window.jQuery(mode).trigger('change');
      notify(`当前生图后端已切换到 ${provider === 'civitai' ? 'Civitai' : 'WaveSpeed'}。`);
    };
    for (const [id, action] of Object.entries({ load, save, models: loadModels, 'jobs-refresh': refreshJobs, 'civitai-estimate': estimate, 'civitai-use': async () => use('civitai'),
      'open-worldbook': async () => window.jQuery('.st-chatu8-nav-link[data-tab="send_data"]').trigger('click'),
      'open-llm': async () => window.jQuery('.st-chatu8-nav-link[data-tab="llm"]').trigger('click'),
      use: async () => {
      use('wavespeed');
    } })) {
      $(id).addEventListener('click', async () => {
        $(id).disabled = true;
        try { await action(); } catch (error) { notify(error.message, true); }
        finally { $(id).disabled = false; }
      });
    }
    $('model').addEventListener('change', schema);
    // Load browser configuration when this page is opened.
    document.querySelector('.st-chatu8-nav-link[data-tab="wavespeed"]')?.addEventListener('click', () => { if (!$('status').dataset.loaded) load().then(() => { $('status').dataset.loaded = 'true'; }).catch(e => notify(e.message, true)); });
  }
  async function exportConfig() { return { version: 1, config: portableConfig(await api('/config')) }; }
  async function importConfig(backup) {
    if (backup === undefined) return;
    if (!backup || backup.version !== 1) throw new Error('不支持的云端生图配置版本。');
    const config = await api('/config', portableConfig(backup.config));
    if ($('model')) fill(config);
  }
  return { updateMode, mount, generate, restore, prepare, exportConfig, importConfig };
}
