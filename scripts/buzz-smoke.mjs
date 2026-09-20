// Run against an isolated Chrome with --remote-debugging-port=9234 and the
// static preview server. Uses simulated provider responses only; no API credit.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const root = new URL('../test-results/buzz/', import.meta.url);
await fs.mkdir(root, { recursive: true });
const targets = await (await fetch('http://127.0.0.1:9234/json/list')).json();
const target = targets.find(t => t.url.startsWith('http://127.0.0.1:8765/tests/'));
assert.ok(target, 'Open a local fixture in an isolated Chromium browser on port 9234 first');
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map(); let sequence = 0;
socket.onmessage = event => { const m = JSON.parse(event.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } };
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
const until = async (expression, predicate) => { for (let i = 0; i < 100; i++) { const result = await evaluate(expression); if (predicate(result)) return result; await new Promise(r => setTimeout(r, 200)); } throw Error(`Timed out: ${expression}`); };
const snapshot = 'fixture.snapshot()';
try {
  await call('Page.navigate', {url:'http://127.0.0.1:8765/tests/settings-browser.html'});
  await until("globalThis.fixture?.ready && !document.getElementById('ws-form').disabled", Boolean);
  const before=(await evaluate(snapshot)).paid.length;
  const records=[];
  for (const [index,currency] of ['yellow','blue','green','blue_green'].entries()) {
    await evaluate(`(()=>{const el=document.getElementById('ws-civitai-currency');el.value='${currency}';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    assert.equal(await evaluate("document.getElementById('ws-save-state').dataset.dirty"),'true');
    // Generation must save an edited currency even without clicking Save first.
    await evaluate('fixture.generateOne()');
    const result=await until(snapshot,s=>s.paid.length===before+index+1 && s.cache.length>=before+index+1);
    const body=result.paid.at(-1).body;
    assert.deepEqual(body.currencies,currency==='blue_green'?['blue','green']:[currency]);
    assert.equal(body.allowMatureContent,currency==='yellow');assert.equal(body.upgradeMode,'manual');
    assert.equal((await evaluate('fixture.config()')).civitaiCurrency,currency);
    records.push({currency,body});
  }
  await evaluate("document.querySelector('#ws-civitai-panel details').open=true;document.getElementById('ws-civitai-estimate').click()");
  await until("document.getElementById('ws-civitai-cost').textContent",s=>s.includes('blue')&&s.includes('manual'));
  await call('Page.reload',{ignoreCache:true});
  await until("globalThis.fixture?.ready && !document.getElementById('ws-form').disabled",Boolean);
  assert.equal(await evaluate("document.getElementById('ws-civitai-currency').value"),'blue_green');
  assert.equal(await evaluate("document.getElementById('ws-saved-summary').textContent.includes('蓝＋绿')"),true);
  for(const [name,width,height,mobile] of [['desktop',1280,1000,false],['mobile',390,844,true]]) {
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
    await evaluate("document.getElementById('ws-civitai-currency').scrollIntoView({block:'center'})");
    assert.equal((await evaluate(snapshot)).overflow,false);
    const shot=await call('Page.captureScreenshot');await fs.writeFile(new URL(`buzz-${name}.png`,root),Buffer.from(shot.data,'base64'));
  }
  await fs.writeFile(new URL('result.json',root),JSON.stringify({passed:true,records,reloadedCurrency:(await evaluate('fixture.config()')).civitaiCurrency},null,2));
  console.log('PASS: all four Buzz selectors → autosave → actual mock workflow; estimate detail, IndexedDB reload, desktop/mobile layout. Mock providers only.');
} finally { socket.close(); }
