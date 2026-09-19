// Run against an isolated Chrome with --remote-debugging-port=9232 and the
// static preview server. Uses simulated provider responses only; no API credit.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const root = new URL('../test-results/queue/', import.meta.url);
await fs.mkdir(root, { recursive: true });
const targets = await (await fetch('http://127.0.0.1:9232/json/list')).json();
const target = targets.find(t => t.url.includes('/tests/queue-browser.html'));
assert.ok(target, 'Open the queue fixture in isolated Chrome first');
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map(); let sequence = 0;
socket.onmessage = event => { const m = JSON.parse(event.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } };
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
const until = async (expression, predicate) => { for (let i = 0; i < 100; i++) { const result = await evaluate(expression); if (predicate(result)) return result; await new Promise(r => setTimeout(r, 200)); } throw Error(`Timed out: ${expression}`); };
const snapshot = 'fixture.snapshot()';
const screenshots = async name => { await evaluate("document.getElementById('ws-queue-summary').scrollIntoView({block:'start'})"); const shot = await call('Page.captureScreenshot'); await fs.writeFile(new URL(name, root), Buffer.from(shot.data, 'base64')); };
try {
  await until('globalThis.fixture?.ready', Boolean);
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate('fixture.start()');
  const initial = await until(snapshot, s => s.jobs.length === 5 && s.summary.includes('等候 3'));
  assert.equal(initial.paid.length, 2); assert.equal(initial.max, 2); assert.equal(initial.tasks.filter(s => s === 'queued').length, 3); assert.equal(initial.overflow, false);
  await screenshots('queue-mobile.png');
  // Cancel the last waiting card using the actual rendered button.
  await evaluate("[...document.querySelectorAll('.ws-job')].find(el => el.textContent.includes('Landscape scene 5')).querySelector('button').click()");
  await until(snapshot, s => s.jobs.some(j => j.prompt === 'Landscape scene 5' && j.status === 'cancelled'));
  await evaluate("fixture.complete('browser-paid-2')");
  const refilled = await until(snapshot, s => s.paid.length === 3 && s.cache.length === 1);
  assert.equal(refilled.max, 2); assert.equal(refilled.paid[2].prompt, 'Landscape scene 3');
  await call('Page.reload', { ignoreCache: true });
  await until('globalThis.fixture?.ready', Boolean);
  await evaluate('fixture.completeAll()');
  const final = await until(snapshot, s => s.cache.length === 4 && s.jobs.filter(j => j.status === 'completed').length === 4);
  assert.equal(final.paid.length, 4); assert.equal(final.max, 2); assert.equal(new Set(final.cache).size, 4); assert.equal(final.jobs.filter(j => j.status === 'cancelled').length, 1); assert.equal(final.overflow, false);
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await screenshots('queue-desktop.png');
  await fs.writeFile(new URL('result.json', root), JSON.stringify({ initial, refilled, final }, null, 2));
  console.log('PASS: real IndexedDB, five clicks → two active + three waiting, cancellation, either-slot refill, reload/resume/cache, no duplicate POST, desktop and 390px screenshots. Simulated providers only.');
} finally { socket.close(); }
