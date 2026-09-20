/* Added by Codex for the workspace owner, 2026-09-19. Aladdin Free Public License; see ../LICENSE.
 * Contract: https://orchestration.civitai.com/openapi/v2-consumers.json
 * Reuses the WaveSpeed job journal, recovery, downloader and per-user isolation.
 */
import { AppError, text, plainObject, validateCivitai, civitaiPayment, civitaiPaymentLabel } from './config.js';
import { authHeaders, jsonRequest } from './http.js';

const API = 'https://orchestration.civitai.com/v2/consumer/workflows';

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
  const blocked = [];
  for (const step of value.steps || []) {
    for (const blob of [...(step.output?.images || []), ...(step.output?.blobs || [])]) {
      if (blob.available === false || blob.blockedReason) blocked.push(blob.blockedReason || '图片不可用，可能被内容规则扣留');
    }
    for (const image of step.output?.images || []) if (image.available && typeof image.url === 'string') outputs.push(image.url);
    for (const blob of step.output?.blobs || []) if (blob.available === true && typeof blob.url === 'string' && (blob.type === 'image' || (blob.mimeType || '').startsWith('image/'))) outputs.push(blob.url);
  }
  const warning = blocked.length ? `Civitai 有图片未放行：${[...new Set(blocked)].join('；')}。插件不会自动换币、补扣或重新生成；请在平台核对原任务。` : '';
  const status = value.status === 'succeeded' ? (outputs.length ? 'completed' : 'failed') : ['failed', 'expired', 'canceled'].includes(value.status) ? 'failed' : 'processing';
  return { id: value.id, status, outputs: [...new Set(outputs)], warning,
    cost: value.cost, transactions: value.transactions,
    error: typeof value.error === 'string' ? value.error : warning || (value.status === 'succeeded' ? 'Civitai 已结束，但没有可下载的图片；请核对原任务，插件不会自动重提或补扣。' : `Civitai 工作流状态：${value.status}`) };
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
    return { warning: result.warning, ...(result.cost ? { buzzCost: result.cost } : {}), ...(result.transactions ? { buzzTransactions: result.transactions } : {}) };
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
