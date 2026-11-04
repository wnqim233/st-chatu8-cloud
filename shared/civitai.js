/* Added by Codex for the workspace owner, 2026-09-19. Aladdin Free Public License; see ../LICENSE.
 * Contract: https://orchestration.civitai.com/openapi/v2-consumers.json
 * Reuses the WaveSpeed job journal, recovery, downloader and per-user isolation.
 */
import { AppError, text, plainObject, validateCivitai, civitaiPayment, civitaiPaymentLabel, safeError } from './config.js';
import { authHeaders, jsonRequest } from './http.js';

const API = 'https://orchestration.civitai.com/v2/consumer/workflows';

function outputKey(url, id) {
  if (typeof id === 'string' && id) return id;
  // Older journals retained only URLs. Civitai blob paths end with the blob ID;
  // query signatures can change whenever the original workflow is fetched.
  try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).at(-1)); }
  catch { return url; }
}

export function workflowBody(job, estimate = false) {
  const krea2 = job.model.startsWith('urn:air:krea2:');
  let input;
  if (krea2) {
    const { variant = 'turbo', ...params } = job.params;
    input = { width: 1024, height: 1024, steps: variant === 'raw' ? 20 : 8,
      cfgScale: variant === 'raw' ? 4 : 1, quantity: 1, sampler: 'euler', scheduler: 'beta',
      ...params, engine: 'comfy', ecosystem: 'krea2', model: variant, operation: 'createImage',
      diffusionModel: job.model, seed: job.params.seed ?? job.seed, prompt: job.prompt };
  } else {
    input = { width: 1024, height: 1024, steps: 25, cfgScale: 5, quantity: 1,
      ...job.params, seed: job.params.seed ?? job.seed, model: job.model, prompt: job.prompt };
  }
  return {
    tags: ['st-chatu8'], ...civitaiPayment(job.civitaiCurrency),
    // Explicitly opt out of both optional tips; these are rates, not Buzz amounts.
    tips: { creators: 0, civitai: 0 },
    // Estimates and paid requests must have separate idempotency identities.
    ...(!estimate ? { externalId: `chatu8-${job.id}` } : {}),
    steps: [{ $type: krea2 ? 'imageGen' : 'textToImage', name: 'image', timeout: '00:10:00', retries: 0, input }],
  };
}

export function normalizeWorkflow(value) {
  if (!plainObject(value) || typeof value.status !== 'string') throw new AppError('Civitai 工作流响应无效，请到平台核对任务。', 502);
  const outputs = [];
  const outputKeys = [];
  const blocked = [];
  const addOutput = blob => {
    if (outputs.includes(blob.url)) return;
    outputs.push(blob.url); outputKeys.push(outputKey(blob.url, blob.id));
  };
  for (const step of value.steps || []) {
    for (const blob of [...(step.output?.images || []), ...(step.output?.blobs || [])]) {
      if (blob.blockedReason || (value.status === 'succeeded' && blob.available === false)) blocked.push(blob.blockedReason || '图片不可用，平台未给出原因');
    }
    for (const image of step.output?.images || []) if (image.available && typeof image.url === 'string') addOutput(image);
    for (const blob of step.output?.blobs || []) if (blob.available === true && typeof blob.url === 'string' && (blob.type === 'image' || (blob.mimeType || '').startsWith('image/'))) addOutput(blob);
  }
  const warning = blocked.length ? `Civitai 有图片未放行：${[...new Set(blocked)].join('；')}。插件不会自动换币、补扣或重新生成；请在平台核对原任务。` : '';
  const status = value.status === 'succeeded' ? (outputs.length ? 'completed' : 'failed') : ['failed', 'expired', 'canceled'].includes(value.status) ? 'failed' : 'processing';
  const failure = value.status === 'expired' ? 'Civitai 原任务已超时，未取得可下载的图片；请核对模型可用性和平台队列。' : `Civitai 工作流状态：${value.status}`;
  return { id: value.id, status, outputs, outputKeys, warning,
    cost: value.cost, transactions: value.transactions,
    error: typeof value.error === 'string' ? value.error : (value.status === 'expired' ? failure : warning || (value.status === 'succeeded' ? 'Civitai 已结束，但没有可下载的图片；请核对原任务，插件不会自动重提或补扣。' : failure)) };
}

export const withCivitai = Base => class CivitaiService extends Base {
  provider = 'civitai';
  label = 'Civitai';

  options(input, config) {
    if (!config.civitaiKey) throw new AppError('请先保存 Civitai API Key。');
    const civitaiCurrency = input.civitaiCurrency ?? config.civitaiCurrency ?? 'yellow';
    civitaiPayment(civitaiCurrency);
    return { ...validateCivitai(input.model ?? config.civitaiModel, input.params ?? config.civitaiParams), civitaiCurrency };
  }

  async estimate(input, config) {
    const { model, params, civitaiCurrency } = this.options(input, config);
    const job = { model, params, civitaiCurrency, seed: input.seed ?? params.seed ?? crypto.getRandomValues(new Uint32Array(1))[0], prompt: text(input.prompt, '预估提示词', model.startsWith('urn:air:krea2:') ? 10000 : 16000, true) };
    const response = await jsonRequest(this.fetcher, `${API}?whatif=true`, {
      method: 'POST', headers: authHeaders(config.civitaiKey), body: JSON.stringify(workflowBody(job, true)),
    }, 20000);
    const total = response?.cost?.total;
    if (!Number.isFinite(total) || total < 0) throw new AppError('Civitai 未返回有效的 Buzz 预估；未提交付费任务。', 502);
    const tips = response.cost.tips;
    if (tips != null && (!plainObject(tips) || tips.creators !== 0 || tips.civitai !== 0)) {
      throw new AppError('已要求 Creator Tip 和 Civitai Tip 均为 0，但平台报价仍包含非零或无效的小费，已阻止付费提交。请核对平台报价。', 502);
    }
    return { estimatedBuzz: total, maxBuzz: config.civitaiMaxBuzz, withinLimit: total <= config.civitaiMaxBuzz,
      civitaiCurrency, payment: civitaiPayment(civitaiCurrency), requestedTips: { creators: 0, civitai: 0 }, cost: response.cost,
      transactions: response.transactions, insufficientBuzz: response.transactions?.insufficientBuzz === true };
  }

  async beforeSubmit(job, config) {
    job.civitaiCurrency = this.options(job, config).civitaiCurrency;
    job.seed = job.params.seed ?? crypto.getRandomValues(new Uint32Array(1))[0];
    const estimate = await this.estimate(job, config);
    if (!estimate.withinLimit) throw new AppError(`Civitai 预估 ${estimate.estimatedBuzz} Buzz，超过已设置的 ${estimate.maxBuzz} Buzz 上限，未提交付费任务。`);
    if (estimate.insufficientBuzz) throw new AppError(`Civitai ${civitaiPaymentLabel(job.civitaiCurrency)}余额不足，未提交付费任务，也不会改扣其他币种。`);
    return { estimatedBuzz: estimate.estimatedBuzz, requestedTips: estimate.requestedTips, buzzEstimate: { cost: estimate.cost, transactions: estimate.transactions } };
  }

  predictionDetails(result) {
    return { warning: result.warning, outputKeys: result.outputKeys, ...(result.cost ? { buzzCost: result.cost } : {}), ...(result.transactions ? { buzzTransactions: result.transactions } : {}) };
  }

  async refreshDownloadOutputs(job, config) {
    const result = await this.refreshPrediction(job, config);
    if (result.status === 'failed') {
      Object.assign(job, this.predictionDetails(result));
      job.status = 'failed'; job.error = safeError(new Error(result.error), config);
      return;
    }
    if (result.status !== 'completed') throw new AppError('Civitai 原任务尚未返回可下载的图片，请稍后查询。');
    const oldKeys = job.outputKeys || (job.outputs || []).map(url => outputKey(url));
    const saved = new Map();
    for (let i = 0; i < (job.images || []).length; i++) {
      if (!job.images[i]) continue;
      const key = oldKeys[i];
      if (!key || oldKeys.filter(value => value === key).length !== 1 || result.outputKeys.filter(value => value === key).length !== 1) {
        throw new AppError('Civitai 原任务的图片列表已变化，已保留本地缓存；请到平台核对原任务。');
      }
      saved.set(key, job.images[i]);
    }
    // Re-query only the existing workflow. Never re-submit a paid generation or
    // attach the API key to a returned CDN URL. Match partial saves by blob ID.
    if (saved.size) {
      const fresh = new Map(result.outputKeys.map((key, index) => [key, result.outputs[index]]));
      if (new Set(oldKeys).size !== oldKeys.length || fresh.size !== result.outputKeys.length || oldKeys.some(key => !fresh.has(key))) {
        throw new AppError('Civitai 原任务的图片列表已变化，已保留本地缓存；请到平台核对原任务。');
      }
      // Keep the original slot numbers: download filenames use these indices.
      // Reordering them could overwrite an image already saved in another slot.
      result.outputKeys = [...oldKeys, ...result.outputKeys.filter(key => !oldKeys.includes(key))];
      result.outputs = result.outputKeys.map(key => fresh.get(key));
    }
    job.outputs = result.outputs;
    job.images = result.outputKeys.map(key => saved.get(key) || '');
    Object.assign(job, this.predictionDetails(result));
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
