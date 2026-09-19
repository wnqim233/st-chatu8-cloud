// Run against an isolated Chrome with --remote-debugging-port=9234 and the
// static preview server. Uses simulated provider responses only; no API credit.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const root = new URL('../test-results/settings-save/', import.meta.url);
await fs.mkdir(root, { recursive: true });
const targets = await (await fetch('http://127.0.0.1:9234/json/list')).json();
const target = targets.find(t => t.url.includes('/tests/settings-browser.html'));
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
  await until("globalThis.fixture?.ready && !document.getElementById('ws-form').disabled", Boolean);
  const a='urn:air:krea2:lora:civitai:100@200',b='urn:air:krea2:lora:civitai:101@201';
  const params={width:1024,height:1024,steps:10,cfgScale:1,sampler:'er_sde',scheduler:'beta',loras:{[a]:0.3,[b]:0.9}};
  const edit=async(id,value)=>evaluate(`(()=>{const el=document.getElementById(${JSON.stringify(id)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  // Invalid hidden WaveSpeed JSON must not block a valid Civitai save.
  await edit('ws-params','{broken');
  await edit('ws-civitai-params',JSON.stringify(params));
  assert.equal(await evaluate("document.getElementById('ws-save-state').textContent.includes('未保存')"),true);
  await evaluate("document.getElementById('ws-save').click()");
  const saved=await until('fixture.config()',c=>c.civitaiParams.steps===10);
  assert.deepEqual(saved.civitaiParams.loras,params.loras);
  await evaluate('fixture.generateOne()');
  const first=await until(snapshot,s=>s.paid.length===1 && s.cache.length===1);
  assert.deepEqual(first.paid[0].body.steps[0].input.loras,params.loras);
  assert.equal(first.paid[0].body.steps[0].input.width,1024);
  // Deleting A and changing B without clicking Save must auto-save before POST.
  params.loras={[b]:0.5};await edit('ws-civitai-params',JSON.stringify(params));
  await evaluate('fixture.generateOne()');
  const second=await until(snapshot,s=>s.paid.length===2 && s.cache.length===2);
  assert.deepEqual(second.paid[1].body.steps[0].input.loras,{[b]:0.5});
  assert.ok(second.jobs[0].configRevision>first.jobs[0].configRevision);
  // Clear LoRAs, use the actual regenerate button, and verify empty workflow map.
  params.loras={};await edit('ws-civitai-params',JSON.stringify(params));
  await evaluate("document.querySelector('details[data-detail-key=history]').open=true; [...document.querySelectorAll('.ws-job button')].find(b=>b.textContent==='按当前配置重新生成').click()");
  const third=await until(snapshot,s=>s.paid.length===3 && s.cache.length===3);
  assert.deepEqual(third.paid[2].body.steps[0].input.loras,{});
  // Parsing failure must not silently generate with the last successful save.
  await edit('ws-civitai-params','{invalid');await evaluate('fixture.generateOne()');
  assert.equal((await evaluate(snapshot)).paid.length,3);
  params.loras={[a]:1};await edit('ws-civitai-params',JSON.stringify(params));
  await evaluate('fixture.failSave(true);fixture.generateOne()');
  assert.equal((await evaluate(snapshot)).paid.length,3);
  assert.deepEqual((await evaluate('fixture.config()')).civitaiParams.loras,{});
  assert.equal(await evaluate("document.getElementById('ws-save-state').dataset.dirty"),'true');
  await evaluate('fixture.failSave(false)');
  await call('Page.reload',{ignoreCache:true});
  await until("globalThis.fixture?.ready && !document.getElementById('ws-form').disabled",Boolean);
  const restored=await evaluate('fixture.config()');assert.deepEqual(restored.civitaiParams.loras,{});
  assert.equal(await evaluate("JSON.parse(document.getElementById('ws-civitai-params').value).steps"),10);
  assert.equal(await evaluate("document.getElementById('ws-wavespeed-panel').hidden"),true);
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal((await evaluate(snapshot)).overflow,false);
  await evaluate('scrollTo(0,0)');let shot=await call('Page.captureScreenshot');await fs.writeFile(new URL('settings-mobile.png',root),Buffer.from(shot.data,'base64'));
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  await evaluate('scrollTo(0,0)');shot=await call('Page.captureScreenshot');await fs.writeFile(new URL('settings-desktop.png',root),Buffer.from(shot.data,'base64'));
  await fs.writeFile(new URL('result.json',root),JSON.stringify({first,second,third,restored},null,2));
  await call('Page.navigate',{url:'http://127.0.0.1:8765/tests/settings-import.html'});
  const imported=await until('globalThis.regression?.result',Boolean);
  assert.equal(imported.passed,true,JSON.stringify(imported));
  await fs.writeFile(new URL('legacy-import.json',root),JSON.stringify(imported,null,2));
  console.log('PASS: real settings inputs and IndexedDB, selected-provider save despite invalid hidden JSON, LoRA edit/delete/clear → exact workflow body, autosave before new request, regenerate, invalid JSON and persistence failure block POST, reload and mobile layout. Mock APIs only.');
} finally { socket.close(); }
