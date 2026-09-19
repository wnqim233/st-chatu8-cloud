/* Added by Codex for the workspace owner, 2026-09-19. Aladdin Free Public License; see ../LICENSE. */
export const DEFAULT_CONFIG = Object.freeze({
  wavespeedKey: '',
  civitaiKey: '', civitaiModel: 'urn:air:sdxl:checkpoint:civitai:101055@128078',
  civitaiParams: { width: 1024, height: 1024, steps: 25, cfgScale: 5, scheduler: 'eulerA', quantity: 1 },
  civitaiMaxBuzz: 100,
  imageModel: 'wavespeed-ai/z-image/turbo', imageParams: { size: '1024*1024' },
  fixedPrompt: '', fixedPromptEnd: '', negativePrompt: '', sizeMode: 'size', negativeField: '',
});

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Transfer provider parameters without transferring browser identity, credentials or jobs.
export function portableConfig(config) {
  if (!plainObject(config)) throw new AppError('云端生图配置必须是 JSON 对象。');
  return Object.fromEntries(Object.keys(DEFAULT_CONFIG)
    .filter(key => !['wavespeedKey', 'civitaiKey'].includes(key) && Object.hasOwn(config, key))
    .map(key => [key, structuredClone(config[key])]));
}

export function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new AppError(`${label}不能为空或超过 ${max} 个字符。`);
  }
  return value.trim();
}

export function validateImage(model, params) {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(model) || model.length > 200 || model.split('/').some(p => p === '..' || p === '.')) {
    throw new AppError('图片模型 ID 无效，例如 wavespeed-ai/z-image/turbo。');
  }
  if (!plainObject(params) || JSON.stringify(params).length > 20000) throw new AppError('模型参数必须是小于 20 KB 的 JSON 对象。');
  for (const key of ['prompt', '__proto__', 'constructor', 'prototype']) {
    if (Object.hasOwn(params, key)) throw new AppError(`模型参数中不能包含 ${key}。`);
  }
  if (params.enable_sync_mode || params.enable_base64_output) throw new AppError('首版使用异步任务和图片 URL，请关闭同步模式与 Base64 输出。');
  return { model, params: structuredClone(params) };
}

export function updateConfig(old, input) {
  if (!plainObject(input)) throw new AppError('配置格式无效。');
  const next = { ...old };
  for (const [key, max] of Object.entries({ imageModel: 200, civitaiModel: 250, fixedPrompt: 16000, fixedPromptEnd: 16000, negativePrompt: 16000, sizeMode: 30, negativeField: 100 })) {
    if (Object.hasOwn(input, key)) next[key] = text(input[key], key, max);
  }
  if (!['size', 'width_height', 'none'].includes(next.sizeMode)) throw new AppError('尺寸映射无效。');
  if (!['', 'negative_prompt'].includes(next.negativeField)) throw new AppError('负面提示词映射无效。');
  for (const key of ['wavespeedKey', 'civitaiKey']) {
    if (input[key] !== undefined && input[key] !== '') next[key] = text(input[key], 'API Key', 4000);
    if (input[`clear_${key}`] === true) next[key] = '';
  }
  if (Object.hasOwn(input, 'imageParams')) next.imageParams = input.imageParams;
  validateImage(next.imageModel, next.imageParams);
  if (Object.hasOwn(input, 'civitaiParams')) next.civitaiParams = input.civitaiParams;
  if (Object.hasOwn(input, 'civitaiMaxBuzz')) next.civitaiMaxBuzz = input.civitaiMaxBuzz;
  validateCivitai(next.civitaiModel, next.civitaiParams);
  if (!Number.isInteger(next.civitaiMaxBuzz) || next.civitaiMaxBuzz < 1 || next.civitaiMaxBuzz > 100000) throw new AppError('单次 Buzz 预估上限须为 1 到 100000 的整数。');
  return next;
}

export function publicConfig(config) {
  const { wavespeedKey, civitaiKey, ...rest } = config;
  return { ...rest, hasWavespeedKey: Boolean(wavespeedKey), hasCivitaiKey: Boolean(civitaiKey) };
}

export function safeError(error, config = {}) {
  let value = String(error?.message || '请求失败，请稍后重试。');
  for (const key of [config.civitaiKey, config.wavespeedKey].filter(Boolean)) value = value.split(key).join('[已隐藏]');
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').slice(0, 600);
}

export function validateCivitai(model, params) {
  if (typeof model !== 'string' || !/^urn:air:[a-zA-Z0-9_-]+:(?:checkpoint|model|diffusionmodel):civitai:\d+@\d+$/.test(model)) throw new AppError('Civitai 模型需要完整 AIR，例如 urn:air:sdxl:checkpoint:civitai:101055@128078。');
  if (!plainObject(params) || JSON.stringify(params).length > 20000) throw new AppError('Civitai 参数必须是小于 20 KB 的 JSON 对象。');
  if (model.startsWith('urn:air:krea2:')) return validateKrea2(model, params);
  const allowed = new Set(['negativePrompt', 'width', 'height', 'steps', 'cfgScale', 'seed', 'scheduler', 'quantity', 'batchSize', 'clipSkip', 'outputFormat', 'additionalNetworks']);
  for (const key of Object.keys(params)) if (!allowed.has(key)) throw new AppError(`Civitai 文生图参数不支持 ${key}。prompt 和 model 由插件填写。`);
  for (const [key, min, max] of [['width', 64, 4084], ['height', 64, 4084], ['steps', 1, 150], ['seed', 0, 4294967295], ['quantity', 1, 16], ['batchSize', 1, 16], ['clipSkip', 1, 12]]) {
    if (params[key] !== undefined && (!Number.isInteger(params[key]) || params[key] < min || params[key] > max)) throw new AppError(`Civitai ${key} 必须为 ${min} 到 ${max} 的整数。`);
  }
  if ((params.quantity ?? 1) * (params.batchSize ?? 1) > 16) throw new AppError('每次任务最多生成 16 张图片。');
  if (params.cfgScale !== undefined && (!Number.isFinite(params.cfgScale) || params.cfgScale < 1 || params.cfgScale > 30)) throw new AppError('cfgScale 必须为 1 到 30。');
  if (params.negativePrompt !== undefined) text(params.negativePrompt, '负面提示词', 30000);
  if (params.scheduler !== undefined && !['eulerA', 'euler', 'lms', 'heun', 'dpM2', 'dpM2A', 'dpM2SA', 'dpM2M', 'dpmsde', 'dpmFast', 'dpmAdaptive', 'lmsKarras', 'dpM2Karras', 'dpM2AKarras', 'dpM2SAKarras', 'dpM2MKarras', 'dpmsdeKarras', 'ddim', 'plms', 'uniPC', 'undefined', 'lcm', 'ddpm', 'deis', 'dpM3MSDE'].includes(params.scheduler)) throw new AppError('Civitai scheduler 无效；注意 eulerA 的大小写。');
  if (params.outputFormat !== undefined && !['jpeg', 'png', 'webP'].includes(params.outputFormat)) throw new AppError('outputFormat 支持 jpeg、png、webP（注意大写 P）。');
  if (params.additionalNetworks !== undefined) {
    if (!plainObject(params.additionalNetworks)) throw new AppError('additionalNetworks 必须是 AIR 到参数对象的映射。');
    for (const [air, network] of Object.entries(params.additionalNetworks)) {
      if (!/^urn:air:[a-zA-Z0-9_-]+:(?:lora|locon|embedding):civitai:\d+@\d+$/.test(air) || !plainObject(network)) throw new AppError('附加网络需要 LoRA / LoCon / embedding 的完整 AIR。');
      for (const key of Object.keys(network)) if (!['strength', 'triggerWord'].includes(key)) throw new AppError(`附加网络参数不支持 ${key}。`);
      if (network.strength !== undefined && !Number.isFinite(network.strength)) throw new AppError('LoRA strength 必须是数字。');
      if (network.triggerWord !== undefined) text(network.triggerWord, '触发词', 1000);
    }
  }
  return { model, params: structuredClone(params) };
}

// Krea 2 uses the imageGen/comfy workflow, whose sampler and scheduler are separate.
function validateKrea2(model, params) {
  const allowed = new Set(['negativePrompt', 'width', 'height', 'steps', 'cfgScale', 'seed', 'sampler', 'scheduler', 'quantity', 'outputFormat', 'variant', 'loras']);
  for (const key of Object.keys(params)) if (!allowed.has(key)) throw new AppError(`Krea 2 参数不支持 ${key}；使用 sampler、scheduler 和 loras。`);
  for (const [key, min, max] of [['width', 64, 2048], ['height', 64, 2048], ['steps', 1, 150], ['seed', 0, 4294967295], ['quantity', 1, 12]]) {
    if (params[key] !== undefined && (!Number.isInteger(params[key]) || params[key] < min || params[key] > max)) throw new AppError(`Krea 2 ${key} 必须为 ${min} 到 ${max} 的整数。`);
  }
  if (params.cfgScale !== undefined && (!Number.isFinite(params.cfgScale) || params.cfgScale < 0 || params.cfgScale > 30)) throw new AppError('Krea 2 cfgScale 必须为 0 到 30。');
  if (params.negativePrompt !== undefined) text(params.negativePrompt, '负面提示词', 10000);
  if (params.variant !== undefined && !['turbo', 'raw'].includes(params.variant)) throw new AppError('Krea 2 variant 支持 turbo 或 raw。');
  const samplers = ['euler', 'euler_ancestral', 'euler_cfg_pp', 'euler_ancestral_cfg_pp', 'heun', 'heunpp2', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpm_fast', 'dpm_adaptive', 'dpmpp_2s_ancestral', 'dpmpp_2s_ancestral_cfg_pp', 'dpmpp_sde', 'dpmpp_sde_gpu', 'dpmpp_2m', 'dpmpp_2m_cfg_pp', 'dpmpp_2m_sde', 'dpmpp_2m_sde_gpu', 'dpmpp_3m_sde', 'dpmpp_3m_sde_gpu', 'ddpm', 'lcm', 'ipndm', 'ipndm_v', 'deis', 'ddim', 'uni_pc', 'uni_pc_bh2', 'res_multistep', 'er_sde'];
  if (params.sampler !== undefined && !samplers.includes(params.sampler)) throw new AppError('Krea 2 sampler 无效，例如 euler。');
  if (params.scheduler !== undefined && !['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta'].includes(params.scheduler)) throw new AppError('Krea 2 scheduler 无效，例如 beta 或 simple；不要沿用 SDXL 的 eulerA。');
  if (params.outputFormat !== undefined && !['jpeg', 'png', 'webP'].includes(params.outputFormat)) throw new AppError('outputFormat 支持 jpeg、png、webP。');
  if (params.loras !== undefined) {
    if (!plainObject(params.loras)) throw new AppError('Krea 2 loras 必须是 AIR 到权重数字的映射。');
    for (const [air, weight] of Object.entries(params.loras)) {
      if (!/^urn:air:krea2:lora:civitai:\d+@\d+$/.test(air) || !Number.isFinite(weight)) throw new AppError('Krea 2 LoRA 需要同系列的完整 AIR 和有限数值权重。');
    }
  }
  return { model, params: structuredClone(params) };
}
