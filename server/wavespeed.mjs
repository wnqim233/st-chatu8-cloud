/* Added by Codex for the workspace owner, 2026-09-19. Aladdin Free Public License; see ../LICENSE. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError, text, plainObject, validateImage, safeError } from './config.mjs';
import { authHeaders, jsonRequest, limitedBody } from './http.mjs';

export { publicJob } from '../shared/jobs.js';
import { WaveSpeedService as SharedWaveSpeedService } from '../shared/jobs.js';

export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  // Do not accept mapped IPv4, link-local, unique-local or unspecified IPv6.
  if (isIP(address) === 6) return /^(2|3)[0-9a-f]{0,3}:/i.test(address);
  return false;
}

export async function checkImageUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new AppError('图片 URL 无效。', 502); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new AppError('只接受公网 HTTPS 图片地址。', 502);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new AppError('图片地址不能指向本机或内网。', 502);
}

export function imageExtension(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpg';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString())) return 'gif';
  throw new AppError('返回文件不是支持的 PNG、JPEG、WebP 或 GIF 图片。', 502);
}

export class WaveSpeedService extends SharedWaveSpeedService {
  constructor(store, options = {}) { super(store, options); this.checkUrl = options.checkUrl || checkImageUrl; }
  async prepareDownloads() { await fs.mkdir(this.store.imageDir, { recursive: true }); }
  async download(raw, stem) {
    let url = raw;
    let response;
    for (let redirects = 0; redirects <= 3; redirects++) {
      await this.checkUrl(url);
      response = await this.fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(60000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new AppError('图片重定向无效。');
        url = new URL(location, url).href;
        continue;
      }
      break;
    }
    if (!response?.ok) throw new AppError(`图片下载失败（HTTP ${response?.status}），可以重试保存。`, 502);
    const buffer = await limitedBody(response, 30 * 1024 * 1024);
    const filename = `${stem}.${imageExtension(buffer)}`;
    const target = path.join(this.store.imageDir, filename);
    const temporary = `${target}.tmp`;
    try { await fs.writeFile(temporary, buffer); await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    return `/user/images/wavespeed-illustrator/${filename}`;
  }
}
