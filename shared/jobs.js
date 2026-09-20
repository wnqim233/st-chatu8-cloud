/* Shared job engine extracted from the tested WaveSpeed server adapter. Aladdin Free Public License. */
import { AppError, text, plainObject, validateImage, safeError } from './config.js';
import { authHeaders, jsonRequest } from './http.js';

const API = 'https://api.wavespeed.ai/api/v3';
const FAILURE = new Set(['failed', 'cancelled', 'timeout', 'deleted']);
export const ACTIVE = new Set(['submitting', 'submitted', 'processing', 'unknown']);

export const MAX_ACTIVE_JOBS = 2;
export const queuedJobs = jobs => jobs.filter(j => j.status === 'queued').sort((a, b) => (a.queueOrder ?? a.createdAt) - (b.queueOrder ?? b.createdAt));

export function validateSource(source) {
  if (!plainObject(source)) throw new AppError('消息来源缺失。');
  return {
    chatId: text(source.chatId, '聊天标识', 1000, true),
    messageId: text(source.messageId, '消息标识', 100, true),
    swipeId: Number.isInteger(source.swipeId) && source.swipeId >= 0 ? source.swipeId : 0,
    hash: text(source.hash, '正文指纹', 100, true),
  };
}

export function publicJob(job) {
  const { outputs, ...rest } = job;
  return rest;
}

function prediction(data) {
  if (data?.code !== 200 || !plainObject(data.data)) throw new AppError('WaveSpeed 返回无效响应，请到平台历史记录核对任务。', 502);
  return data.data;
}

export class WaveSpeedService {
  provider = 'wavespeed';
  label = 'WaveSpeed';
  constructor(store, { fetcher = fetch, now = Date.now } = {}) {
    this.store = store; this.fetcher = fetcher; this.now = now;
  }

  async listModels(config) {
    if (!config.wavespeedKey) throw new AppError('请先保存 WaveSpeed API Key。');
    const result = await jsonRequest(this.fetcher, `${API}/models`, { headers: authHeaders(config.wavespeedKey) }, 60000, 16 * 1024 * 1024);
    if (!Array.isArray(result.data)) throw new AppError('模型列表格式无效。', 502);
    return result.data.filter(m => m.type === 'text-to-image').map(m => ({
      id: m.model_id, name: m.name, schema: m.api_schema?.api_schemas?.find(s => s.type === 'model_run')?.request_schema,
    }));
  }

  options(input, config) {
    if (!config.wavespeedKey) throw new AppError('请先保存 WaveSpeed API Key。');
    return validateImage(input.model ?? config.imageModel, input.params ?? config.imageParams);
  }
  async beforeSubmit() { return {}; }
  predictionDetails() { return {}; }
  async submitPrediction(job, config) {
    return prediction(await jsonRequest(this.fetcher, `${API}/${job.model}`, {
      method: 'POST', headers: authHeaders(config.wavespeedKey), body: JSON.stringify({ ...job.params, prompt: job.prompt }),
    }));
  }
  async refreshPrediction(job, config) {
    if (!config.wavespeedKey) throw new AppError('请先保存 WaveSpeed API Key。');
    return prediction(await jsonRequest(this.fetcher, `${API}/predictions/${encodeURIComponent(job.taskId)}/result`, { headers: authHeaders(config.wavespeedKey) }, 30000));
  }

  async submit(input, config) {
    if (!plainObject(input) || !/^[a-zA-Z0-9-]{16,80}$/.test(input.id)) throw new AppError('任务标识无效。');
    const prompt = text(input.prompt, '绘图提示词', 16000, true);
    const source = validateSource(input.source);
    const options = this.options(input, config);
    const { model, params } = options;
    return this.store.exclusive('submit', async () => {
      const jobs = await this.store.jobs();
      const existing = jobs.find(j => j.id === input.id);
      if (existing) {
        if ((existing.provider || 'wavespeed') !== this.provider) throw new AppError('任务 ID 已被另一个后端使用。');
        return existing;
      }
      const unfinished = jobs.find(j => (j.provider || 'wavespeed') === this.provider && j.prompt === prompt && j.model === model && j.civitaiCurrency === options.civitaiCurrency && JSON.stringify(j.params) === JSON.stringify(params) && j.source.chatId === source.chatId && (ACTIVE.has(j.status) || j.status === 'queued'));
      if (unfinished) return unfinished;
      const autoKey = input.automatic === true ? JSON.stringify(source) : '';
      const automatic = autoKey && jobs.find(j => (j.provider || 'wavespeed') === this.provider && j.autoKey === autoKey && !['failed', 'cancelled'].includes(j.status));
      if (automatic) return automatic;
      const mustQueue = jobs.some(j => j.status === 'queued') || jobs.filter(j => ACTIVE.has(j.status)).length >= MAX_ACTIVE_JOBS;
      const job = {
        id: input.id, provider: this.provider, source, prompt, ...options, autoKey,
        configRevision: Number.isSafeInteger(input.configRevision) ? input.configRevision : config.revision || 0,
        dimensionSource: input.dimensionSource === 'request' ? 'request' : 'json',
        status: 'queued', queueOrder: Math.max(0, ...jobs.map(j => j.queueOrder ?? j.createdAt)) + 1, taskId: '', images: [], outputs: [], error: '',
        createdAt: this.now(), updatedAt: this.now(), nextPollAt: 0,
        cacheTag: text(input.cacheTag ?? prompt, '原插件图片标签', 30000, true),
        change: text(input.change ?? '', '修改后的提示词', 30000),
      };
      if (mustQueue) return this.store.saveJob(job);
      return this.start(job, config);
    });
  }

  // Caller must hold the shared submit lock across admission and the paid POST.
  async start(job, config) {
    this.options(job, config);
    Object.assign(job, await this.beforeSubmit(job, config));
    job.status = 'submitting'; job.startedAt = this.now();
    // Persist before making the paid request. Never automatically resubmit this job.
    await this.store.saveJob(job);
    try {
      const result = await this.submitPrediction(job, config);
      Object.assign(job, this.predictionDetails(result));
      if (typeof result.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(result.id)) throw new AppError(`${this.label} 未返回有效任务 ID。`, 502);
      job.taskId = result.id;
      job.status = 'submitted';
      job.nextPollAt = this.now() + 2500;
      if (FAILURE.has(result.status)) { job.status = 'failed'; job.error = safeError(new Error(String(result.error || `任务状态：${result.status}`)), config); }
      if (result.status === 'completed') { job.outputs = result.outputs; job.status = 'download_failed'; }
    } catch (error) {
      const rejected = [400, 401, 403, 404, 405, 413, 422, 429].includes(error.upstreamStatus);
      job.status = rejected ? 'failed' : 'unknown';
      job.error = safeError(error, config) + (rejected ? '' : ` 提交结果尚未确认。请在 ${this.label} 历史记录查找任务 ID 后恢复，勿直接重复提交。`);
    }
    job.updatedAt = this.now();
    await this.store.saveJob(job);
    return job;
  }

  async startQueued(id, config) {
    return this.store.exclusive('submit', async () => {
      const jobs = await this.store.jobs();
      const job = jobs.find(j => j.id === id);
      if (!job || job.status !== 'queued' || queuedJobs(jobs)[0]?.id !== id || jobs.filter(j => ACTIVE.has(j.status)).length >= MAX_ACTIVE_JOBS) return;
      try { return await this.start(job, config); }
      catch (error) {
        // Only preflight errors reach here before submission. A failed persistence
        // after a paid POST must never turn an ambiguous task into a free slot.
        if (job.status !== 'queued') throw error;
        job.status = 'failed'; job.error = safeError(error, config); job.updatedAt = this.now();
        return this.store.saveJob(job);
      }
    });
  }

  async cancel(id) {
    return this.store.exclusive('submit', async () => {
      const job = await this.store.job(id);
      if (!job || job.status !== 'queued') throw new AppError('只能取消尚未提交的排队任务；已提交的任务会继续查询。');
      job.status = 'cancelled'; job.error = '已取消排队，未向平台提交。'; job.updatedAt = this.now();
      return this.store.saveJob(job);
    });
  }

  async recover(id, taskId) {
    if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(taskId)) throw new AppError('任务 ID 无效。');
    return this.store.exclusive(`job:${id}`, async () => {
      const job = await this.store.job(id);
      if (!job || !['unknown', 'submitting'].includes(job.status)) throw new AppError('只有提交状态未知的任务可以补填 ID。');
      // Do not race an in-flight submit.
      if (job.status === 'submitting' && this.now() - (job.startedAt ?? job.createdAt) < 90000) throw new AppError('任务仍在提交，请稍等。');
      job.taskId = taskId; job.status = 'submitted'; job.error = ''; job.nextPollAt = 0;
      return this.store.saveJob(job);
    });
  }

  async dismiss(id) {
    return this.store.exclusive(`job:${id}`, async () => {
      const job = await this.store.job(id);
      if (!job || !['unknown', 'submitting'].includes(job.status) || this.now() - (job.startedAt ?? job.createdAt) < 90000) throw new AppError('只能结束提交超过 90 秒且状态未知的本地记录。');
      job.status = 'failed'; job.error = '用户结束了本地跟踪；这不会取消平台上可能存在的任务，也不代表退款。';
      return this.store.saveJob(job);
    });
  }

  async refresh(id, config, onSlotAvailable = async () => {}) {
    return this.store.exclusive(`job:${id}`, async () => {
      const job = await this.store.job(id);
      if (!job) throw new AppError('任务不存在。', 404);
      if (['queued', 'cancelled', 'completed', 'failed', 'unknown'].includes(job.status)) return job;
      if (job.status === 'submitting') {
        if (this.now() - (job.startedAt ?? job.createdAt) > 90000) {
          job.status = 'unknown'; job.error = `提交中断，未记录到任务 ID。请核对 ${this.label} 历史记录并恢复。`;
          await this.store.saveJob(job);
        }
        return job;
      }
      if (this.now() < job.nextPollAt) return job;
      job.nextPollAt = this.now() + 3000;
      try {
        if (job.status !== 'download_failed') {
          const result = await this.refreshPrediction(job, config);
          Object.assign(job, this.predictionDetails(result));
          if (FAILURE.has(result.status)) {
            job.status = 'failed'; job.error = safeError(new Error(typeof result.error === 'string' ? result.error : `生成失败：${result.status}`), config);
          } else if (result.status === 'completed') {
            job.outputs = result.outputs; job.status = 'download_failed'; job.error = '';
          } else { job.status = 'processing'; job.error = ''; }
          if (['failed', 'download_failed'].includes(job.status)) {
            job.updatedAt = this.now();
            await this.store.saveJob(job);
            await onSlotAvailable();
          }
        }
        if (job.status === 'download_failed') {
          if (!Array.isArray(job.outputs) || !job.outputs.length || job.outputs.length > 16 || job.outputs.some(o => typeof o !== 'string')) throw new AppError('模型未返回有效的图片 URL 列表。');
          await this.prepareDownloads();
          for (let i = 0; i < job.outputs.length; i++) {
            if (job.images[i]) continue;
            const file = await this.download(job.outputs[i], `${job.id}-${i}`);
            job.images[i] = file;
            await this.store.saveJob(job);
          }
          job.status = 'completed'; job.error = '';
        }
      } catch (error) {
        job.error = safeError(error, config);
        job.nextPollAt = this.now() + 10000;
      }
      job.updatedAt = this.now();
      await this.store.saveJob(job);
      return job;
    });
  }

  async prepareDownloads() {}
  async download(raw, stem) { return this.store.download(raw, stem, this.fetcher); }
}
