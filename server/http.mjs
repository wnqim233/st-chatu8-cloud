/* Node download compatibility; all JSON requests use the shared browser-safe implementation. */
import { limitedBody as bytes } from '../shared/http.js';
export { jsonRequest, authHeaders } from '../shared/http.js';
export async function limitedBody(response, limit) { return Buffer.from(await bytes(response, limit)); }
