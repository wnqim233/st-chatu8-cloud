/* Browser-only transport for the upstream-derived extension. Aladdin Free Public License.
 * Reuses the shared, tested provider/job engine; no SillyTavern server plugin required.
 */
import { DEFAULT_CONFIG, AppError, publicConfig, updateConfig, safeError } from '../shared/config.js';
import { WaveSpeedService, publicJob } from '../shared/jobs.js';
import { withCivitai } from '../shared/civitai.js';
import { limitedBody } from '../shared/http.js';

const CivitaiService = withCivitai(WaveSpeedService);
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');

export class BrowserStore {
  constructor(scope, { idb = globalThis.indexedDB, locks = globalThis.navigator?.locks } = {}) {
    this.name = `st-chatu8-cloud-api-${scope}`; this.idb = idb; this.webLocks = locks;
    this.pending = new Map(); this.urls = new Map();
  }
  async open() {
    if (!this.connection) this.connection = new Promise((resolve, reject) => {
      if (!this.idb) { reject(new AppError('浏览器无法使用 IndexedDB，请允许网站存储后重试。')); return; }
      const request = this.idb.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new AppError('无法打开浏览器存储；请检查隐私模式或网站存储权限。'));
      request.onblocked = () => reject(new AppError('存储升级被其他页面占用，请关闭其他酒馆标签页后重试。'));
    });
    return this.connection;
  }
  async access(mode, callback) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', mode); const store = tx.objectStore('records');
      let result;
      try { result = callback(store); } catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => resolve(result?.result);
      tx.onabort = tx.onerror = () => reject(new AppError('浏览器保存失败，请检查网站存储空间；已提交的任务不要重新生成。'));
    });
  }
  read(key) { return this.access('readonly', store => store.get(key)); }
  write(key, value) { return this.access('readwrite', store => store.put(value, key)); }
  async config() { return { ...structuredClone(DEFAULT_CONFIG), ...await this.read('config') }; }
  saveConfig(config) { return this.write('config', config); }
  async jobs() { return await this.read('jobs') || []; }
  async job(id) { return (await this.jobs()).find(job => job.id === id); }
  async saveJob(job) {
    return this.exclusive('journal', async () => {
      const jobs = await this.jobs(); const index = jobs.findIndex(item => item.id === job.id);
      if (index >= 0) jobs[index] = job; else jobs.push(job);
      const terminal = new Set(jobs.filter(item => ['completed', 'failed'].includes(item.status)).slice(-200).map(item => item.id));
      const retained = jobs.filter(item => !['completed', 'failed'].includes(item.status) || terminal.has(item.id));
      const removed = jobs.filter(item => !retained.includes(item));
      await this.access('readwrite', store => {
        store.put(retained, 'jobs');
        for (const item of removed) for (const image of item.images || []) store.delete(`image:${image}`);
      });
      for (const item of removed) for (const image of item.images || []) { const url = this.urls.get(image); if (url) URL.revokeObjectURL(url); this.urls.delete(image); }
      return job;
    });
  }
  async exclusive(key, operation) {
    if (this.webLocks) return this.webLocks.request(`${this.name}:${key}`, operation);
    // Older browsers still serialize requests within this page.
    const before = this.pending.get(key) || Promise.resolve();
    const next = before.catch(() => {}).then(operation); this.pending.set(key, next);
    try { return await next; } finally { if (this.pending.get(key) === next) this.pending.delete(key); }
  }
  async download(raw, stem, fetcher) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/i.test(url.hostname) || /\.(local|localhost)$/i.test(url.hostname)) throw new AppError('平台返回的图片地址不是有效的公网 HTTPS 地址。');
    // Civitai blob endpoints redirect to a signed download on their own domain.
    // Only these trusted provider endpoints may follow redirects; never send API credentials.
    const civitaiBlob = ['orchestration.civitai.com', 'orchestration-new.civitai.com'].includes(url.hostname);
    const response = await fetcher(url.href, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: civitaiBlob ? 'follow' : 'error', signal: AbortSignal.timeout(60000) });
    if (civitaiBlob) {
      const finalUrl = new URL(response.url || url.href);
      if (finalUrl.protocol !== 'https:' || finalUrl.username || finalUrl.password || (finalUrl.port && finalUrl.port !== '443') || !finalUrl.hostname.endsWith('.civitai.com')) throw new AppError('Civitai 图片跳转到了非预期地址，未保存图片。');
    }
    if (!response.ok) throw new AppError(`图片下载失败（HTTP ${response.status}），请查询原任务重试保存。`);
    const bytes = await limitedBody(response, 30 * 1024 * 1024);
    const format = detectImage(bytes);
    await this.write(`image:${stem}`, new Blob([bytes], { type: `image/${format === 'jpg' ? 'jpeg' : format}` }));
    return stem;
  }
  async expose(job) {
    const copy = publicJob(structuredClone(job)); copy.images = []; copy.formats = [];
    for (const id of job.images || []) {
      const blob = await this.read(`image:${id}`);
      if (!blob) continue;
      if (!this.urls.has(id)) this.urls.set(id, URL.createObjectURL(blob));
      copy.images.push(this.urls.get(id)); copy.formats.push(blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png');
    }
    return copy;
  }
}

export function detectImage(bytes) {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  const ascii = new TextDecoder().decode(bytes.subarray(0, 12));
  if (ascii.startsWith('RIFF') && ascii.slice(8) === 'WEBP') return 'webp';
  if (/^GIF8[79]a/.test(ascii)) return 'gif';
  throw new AppError('下载结果不是 PNG、JPEG、WebP 或 GIF 图片。');
}

export function createBrowserApi(deps, { fetcher = globalThis.fetch, storeFactory = scope => new BrowserStore(scope), now } = {}) {
  const sessions = new Map();
  function session() {
    const settings = deps.settings();
    if (!settings.cloudStorageId) { settings.cloudStorageId = randomId(); deps.saveSettings(); }
    const scope = settings.cloudStorageId;
    if (!sessions.has(scope)) {
      const store = storeFactory(scope); const options = { fetcher, ...(now ? { now } : {}) };
      sessions.set(scope, { store, wavespeed: new WaveSpeedService(store, options), civitai: new CivitaiService(store, options) });
    }
    return sessions.get(scope);
  }
  return async (route, body) => {
    const user = session(); const { store } = user; let config;
    try {
      config = await store.config();
      if (route === '/config') {
        if (body === undefined) return publicConfig(config);
        return await store.exclusive('config', async () => {
          const next = updateConfig(await store.config(), body); await store.saveConfig(next); return publicConfig(next);
        });
      }
      if (route === '/models') return await user.wavespeed.listModels(config);
      if (route === '/civitai/estimate') return await user.civitai.estimate(body, config);
      if (route === '/jobs' && body === undefined) return await Promise.all((await store.jobs()).reverse().map(job => store.expose(job)));
      if (route === '/jobs') {
        const provider = body?.provider || 'wavespeed';
        if (!['wavespeed', 'civitai'].includes(provider)) throw new AppError('未知的生图后端。');
        return await store.expose(await user[provider].submit(body, config));
      }
      const match = route.match(/^\/jobs\/([a-zA-Z0-9-]+)\/(refresh|recover|dismiss)$/);
      if (match) {
        const job = await store.job(match[1]); if (!job) throw new AppError('任务不存在。');
        const service = user[job.provider || 'wavespeed'];
        const result = match[2] === 'refresh' ? await service.refresh(job.id, config) : match[2] === 'recover' ? await service.recover(job.id, body?.taskId) : await service.dismiss(job.id);
        return await store.expose(result);
      }
      throw new AppError('不支持的操作。');
    } catch (error) { throw new AppError(safeError(error, config)); }
  };
}
