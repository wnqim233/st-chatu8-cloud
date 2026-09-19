/* Added by Codex for the workspace owner, 2026-09-19.
 * WaveSpeed adapter for st-chatu8. Aladdin Free Public License; see ../LICENSE.
 */
export const LABELS = { submitting: '正在提交', submitted: '已提交', processing: '生成中', download_failed: '等待保存图片', completed: '图片已保存', failed: '未完成', unknown: '提交结果待核对' };

export function makeId() {
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function imagePath(path) {
  if (typeof path !== 'string') return false;
  if (/^\/user\/images\/wavespeed-illustrator\/[a-zA-Z0-9-]+\.(png|jpg|webp|gif)$/.test(path)) return true;
  try { return path.startsWith('blob:') && new URL(path).origin === globalThis.location?.origin; } catch { return false; }
}

export function mapParameters(config, request, negative = '') {
  const params = structuredClone(config.imageParams);
  const width = Number(request.width), height = Number(request.height);
  if (Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0) {
    if (config.sizeMode === 'size') params.size = `${width}*${height}`;
    if (config.sizeMode === 'width_height') { params.width = width; params.height = height; }
  }
  if (config.negativeField && negative.trim()) params[config.negativeField] = [params[config.negativeField], negative.trim()].filter(Boolean).join(', ');
  return params;
}

export function providerConfig(config, provider) {
  return provider === 'civitai' ? { ...config, imageModel: config.civitaiModel, imageParams: config.civitaiParams, sizeMode: 'width_height', negativeField: 'negativePrompt' } : config;
}

export async function waitForJob(api, initial, { onUpdate = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, timeout = 240000 } = {}) {
  const start = now();
  let job = initial;
  while (true) {
    onUpdate(job);
    if (job.status === 'completed') return job;
    if (['failed', 'unknown'].includes(job.status)) throw new Error(job.error || LABELS[job.status]);
    if (now() - start >= timeout) throw new Error(`任务还未完成，已保留任务 ID ${job.taskId || job.id}。请在 WaveSpeed / Civitai 页查询恢复，勿重复生图。`);
    await sleep(3000);
    try { job = await api(`/jobs/${encodeURIComponent(job.id)}/refresh`, {}); }
    catch (error) { onUpdate({ ...job, error: error.message }); }
  }
}

export async function readLocalImage(path, fetcher = fetch) {
  if (!imagePath(path)) throw new Error('图片缓存路径无效。');
  const response = await fetcher(path);
  if (!response.ok) throw new Error('图片已生成，但读取已保存图片失败；请在任务页恢复。');
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取图片内容失败。'));
    reader.readAsDataURL(blob);
  });
}
