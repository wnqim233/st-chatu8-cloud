/* Added by Codex for the workspace owner, 2026-09-19. Aladdin Free Public License; see ../LICENSE. */
import { AppError } from './config.js';

export async function limitedBody(response, limit = 2 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > limit) throw new AppError('远程响应超过大小限制。', 502);
  const chunks = [];
  let size = 0;
  if (!response.body) throw new AppError('远程响应为空。', 502);
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new AppError('远程响应超过大小限制。', 502);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export async function jsonRequest(fetcher, url, options = {}, timeout = 60000, limit = 2 * 1024 * 1024) {
  let response;
  try {
    response = await fetcher(url, { ...options, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(timeout) });
    const raw = new TextDecoder().decode(await limitedBody(response, limit));
    let data;
    try { data = JSON.parse(raw); } catch { throw new AppError(`远程返回了非 JSON 响应（HTTP ${response.status}），请检查 API 地址。`, 502); }
    if (!response.ok) {
      const detail = typeof data.error === 'string' ? data.error : data.error?.message || data.message || '';
      const error = new AppError(`API 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`, response.status === 429 ? 429 : 502);
      error.upstreamStatus = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(error.name === 'TimeoutError' ? 'API 请求超时。' : '无法连接 API，请检查网络；也可能是平台的浏览器跨域限制。已提交的任务请先查询，勿重复生成。', 502);
  }
}

export function authHeaders(key) {
  return { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}
