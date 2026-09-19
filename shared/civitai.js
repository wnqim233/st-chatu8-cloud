/* Added by Codex for the workspace owner, 2026-09-19. Aladdin Free Public License; see ../LICENSE.
 * Contract: https://orchestration.civitai.com/openapi/v2-consumers.json
 * Reuses the WaveSpeed job journal, recovery, downloader and per-user isolation.
 */
import { AppError, text, plainObject, validateCivitai } from './config.js';
import { authHeaders, jsonRequest } from './http.js';

const API = 'https://orchestration.civitai.com/v2/consumer/workflows';

export function workflowBody(job, estimate = false) {
  return {
    tags: ['st-chatu8'], currencies: [],
    // The current API also reserves externalId for what-if requests. Never
    // reuse the estimate's idempotency key for a paid submission.
    ...(!estimate ? { externalId: `chatu8-${job.id}` } : {}),
    steps: [{ $type: 'textToImage', name: 'image', timeout: '00:10:00', retries: 0,
      input: { width: 1024, height: 1024, steps: 25, cfgScale: 5, quantity: 1,
        ...job.params, seed: job.params.seed ?? job.seed, model: job.model, prompt: job.prompt } }],
  };
}

export function normalizeWorkflow(value) {
  if (!plainObject(value) || typeof value.status !== 'string') throw new AppError('Civitai 工作流响应无效，请到平台核对任务。', 502);
  const outputs = [];
  for (const step of value.steps || []) {
    for (const image of step.output?.images || []) if (image.available && typeof image.url === 'string') outputs.push(image.url);
    for (const blob of step.output?.blobs || []) if (blob.available !== false && typeof blob.url === 'string' && (blob.mimeType || blob.type || '').startsWith('image/')) outputs.push(blob.url);
  }
  const status = value.status === 'succeeded' ? 'completed' : ['failed', 'expired', 'canceled'].includes(value.status) ? 'failed' : 'processing';
  return { id: value.id, status, outputs: [...new Set(outputs)], error: typeof value.error === 'string' ? value.error : `Civitai 工作流状态：${value.status}` };
}

export const withCivitai = Base => class CivitaiService extends Base {
  provider = 'civitai';
  label = 'Civitai';

  options(input, config) {
    if (!config.civitaiKey) throw new AppError('请先保存 Civitai API Key。');
    return validateCivitai(input.model ?? config.civitaiModel, input.params ?? config.civitaiParams);
  }

  async estimate(input, config) {
    const { model, params } = this.options(input, config);
    const job = { model, params, seed: input.seed ?? params.seed ?? crypto.getRandomValues(new Uint32Array(1))[0], prompt: text(input.prompt, '预估提示词', 16000, true) };
    const response = await jsonRequest(this.fetcher, `${API}?whatif=true`, {
      method: 'POST', headers: authHeaders(config.civitaiKey), body: JSON.stringify(workflowBody(job, true)),
    }, 20000);
    const total = response?.cost?.total;
    if (!Number.isFinite(total) || total < 0) throw new AppError('Civitai 未返回有效的 Buzz 预估；未提交付费任务。', 502);
    return { estimatedBuzz: total, maxBuzz: config.civitaiMaxBuzz, withinLimit: total <= config.civitaiMaxBuzz };
  }

  async beforeSubmit(job, config) {
    job.seed = job.params.seed ?? crypto.getRandomValues(new Uint32Array(1))[0];
    const estimate = await this.estimate(job, config);
    if (!estimate.withinLimit) throw new AppError(`Civitai 预估 ${estimate.estimatedBuzz} Buzz，超过已设置的 ${estimate.maxBuzz} Buzz 上限，未提交付费任务。`);
    return { estimatedBuzz: estimate.estimatedBuzz };
  }

  async submitPrediction(job, config) {
    return normalizeWorkflow(await jsonRequest(this.fetcher, API, {
      method: 'POST', headers: authHeaders(config.civitaiKey), body: JSON.stringify(workflowBody(job)),
    }));
  }

  async refreshPrediction(job, config) {
    if (!config.civitaiKey) throw new AppError('请先保存 Civitai API Key。');
    return normalizeWorkflow(await jsonRequest(this.fetcher, `${API}/${encodeURIComponent(job.taskId)}`, { headers: authHeaders(config.civitaiKey) }, 30000));
  }
}
