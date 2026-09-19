// Static local fixture only. There are deliberately no /api/plugins routes.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  try {
    let url = new URL(req.url, 'http://localhost').pathname;
    if (url.startsWith('/api/')) { res.writeHead(404).end(); return; }
    if (url === '/') url = '/tests/preview.html';
    const file = path.resolve(root, `.${url}`);
    if (!file.startsWith(`${root}${path.sep}`) || /\/\./.test(url)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
server.listen(8765, '127.0.0.1', () => console.log('Static browser-only fixture: http://127.0.0.1:8765'));
process.on('SIGTERM', () => server.close()); process.on('SIGINT', () => server.close());
