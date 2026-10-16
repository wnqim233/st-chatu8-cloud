// Real settings DOM and shipped preset handlers. Local storage replaces ST persistence;
// generation prompt preparation uses the real cloud adapter, without a paid API call.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const targets = await (await fetch('http://127.0.0.1:9234/json/list')).json();
const target = targets.find(t => t.url.startsWith('http://127.0.0.1:8765/tests/'));
assert.ok(target, 'Open a local test page in isolated Chrome on port 9234');
const socket = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(); let sequence = 0;
socket.onmessage = event => { const m = JSON.parse(event.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } };
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const until = async expression => { for (let n = 0; n < 100; n++) { const r = await evaluate(expression); if (r) return r; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('Timed out: ' + expression); };
const edit = (id, value) => evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
const select = value => evaluate(`(()=>{const e=document.getElementById('prompt_replace_id_wavespeed');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const root = new URL('../test-results/cloud-prompt-replace/', import.meta.url);
const results = [];
const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); results.push(name); };
const setup = async () => {
  await until('globalThis.regression?.result?.passed');
  await evaluate("import('/tests/cloud-prompt-replace-fixture.mjs')");
  await until('globalThis.cloudReplace?.ready && !document.getElementById("ws-form").disabled');
};
try {
  await call('Page.navigate', { url: 'http://127.0.0.1:8765/tests/settings-import.html' });
  await until('globalThis.regression?.result');
  await evaluate("localStorage.removeItem('cloud-prompt-replace-fixture')");
  await setup();
  await evaluate("document.getElementById('ws-prompt-replace').open=true");
  await check('cloud page loads the existing shared preset without switching backend', "cloudReplace.settings.mode==='civitai' && regression.state().nav==='wavespeed' && document.getElementById('prompt_replace_text_wavespeed').value==='白发=替换|silver hair' && regression.settingsModal.find('[data-tab=sd]')[0].style.display==='none'");
  const rule = '白发=替换|silver hair\nre(eyes:(blue|green))=替换|re($1 eyes)';
  await edit('prompt_replace_text_wavespeed', rule);
  await check('draft is marked unsaved and does not change the active rules', "document.getElementById('ws-prompt-replace-state').dataset.dirty==='true' && cloudReplace.settings.prompt_replace['旧规则'].text==='白发=替换|silver hair'");
  await click('prompt_replace_update_style_wavespeed');
  await until("document.getElementById('ws-prompt-replace-state').dataset.dirty==='false'");
  await check('save updates the shared settings and original SD controls', `cloudReplace.saved().prompt_replace['旧规则'].text===${JSON.stringify(rule)} && document.getElementById('prompt_replace_text').value===${JSON.stringify(rule)}`);
  for (const provider of ['civitai', 'wavespeed']) {
    const prepared = await evaluate(`cloudReplace.prepare('${provider}','白发, eyes:blue, long hair')`);
    assert.equal(prepared.prompt, 'silver hair, blue eyes, long hair'); results.push(provider + ': saved rule reaches the actual generation prompt');
  }
  await edit('prompt_replace_text', 'SD 页尚未保存的草稿');
  await edit('prompt_replace_text_wavespeed', rule + '\ncoat=替换|jacket');
  await click('prompt_replace_update_style_wavespeed');
  await check('saving in cloud preserves a different unsaved draft on another page', "document.getElementById('prompt_replace_text').value==='SD 页尚未保存的草稿'");
  await call('Page.reload', { ignoreCache: true }); await setup();
  await check('reload restores the saved preset and selection', "document.getElementById('prompt_replace_id_wavespeed').value==='旧规则' && document.getElementById('prompt_replace_text_wavespeed').value.endsWith('coat=替换|jacket')");
  await edit('ws-civitai-params', '{cloud parameters still being edited');
  await evaluate("cloudReplace.inputs.push('新规则')"); await click('prompt_replace_new_wavespeed');
  await check('new preset works without resetting the backend or unfinished provider JSON', "cloudReplace.settings.mode==='civitai' && cloudReplace.settings.prompt_replace_id==='新规则' && document.getElementById('prompt_replace_text_wavespeed').value==='' && document.getElementById('ws-civitai-params').value==='{cloud parameters still being edited'");
  await edit('prompt_replace_text_wavespeed', rule);
  await evaluate("cloudReplace.inputs.push('备用规则')"); await click('prompt_replace_save_style_wavespeed');
  await check('save as creates and activates a preset with the edited text', `cloudReplace.saved().prompt_replace_id==='备用规则' && cloudReplace.saved().prompt_replace['备用规则'].text===${JSON.stringify(rule)}`);
  await evaluate("cloudReplace.inputs.push('常用规则')"); await click('prompt_replace_rename_wavespeed');
  await check('rename updates every preset selector', "cloudReplace.settings.prompt_replace_id==='常用规则' && !Object.hasOwn(cloudReplace.settings.prompt_replace,'备用规则') && document.getElementById('prompt_replace_id').value==='常用规则'");
  await edit('prompt_replace_text_wavespeed', '未保存的草稿');
  await evaluate('cloudReplace.confirmations.push(false)'); await select('旧规则');
  await check('cancelling a preset switch retains the current selection and draft', "cloudReplace.settings.prompt_replace_id==='常用规则' && document.getElementById('prompt_replace_id_wavespeed').value==='常用规则' && document.getElementById('prompt_replace_text_wavespeed').value==='未保存的草稿'");
  await evaluate('cloudReplace.confirmations.push(true)'); await select('旧规则');
  await check('confirmed preset switch loads saved rules', "cloudReplace.saved().prompt_replace_id==='旧规则' && document.getElementById('prompt_replace_text_wavespeed').value.endsWith('coat=替换|jacket')");
  await select('新规则'); await click('prompt_replace_delete_style_wavespeed');
  await check('delete removes only the chosen preset and selects default', "!Object.hasOwn(cloudReplace.settings.prompt_replace,'新规则') && cloudReplace.settings.prompt_replace_id==='默认' && Object.hasOwn(cloudReplace.settings.prompt_replace,'旧规则')");
  await evaluate(`(()=>{const old=HTMLInputElement.prototype.click;HTMLInputElement.prototype.click=function(){if(this.type!=='file')return old.call(this);const d=new DataTransfer();d.items.add(new File([JSON.stringify({'导入规则':{text:'雨天=替换|rainy day'}})],'rules.json',{type:'application/json'}));this.files=d.files;this.dispatchEvent(new Event('change'))};try{document.getElementById('prompt_replace_import_wavespeed').click()}finally{HTMLInputElement.prototype.click=old}})()`);
  await until("cloudReplace.settings.prompt_replace['导入规则']"); await select('导入规则');
  await check('imported file is available immediately on cloud and original pages', "document.getElementById('prompt_replace_text_wavespeed').value==='雨天=替换|rainy day' && document.getElementById('prompt_replace_text').value==='雨天=替换|rainy day'");
  const exported = await evaluate(`(async()=>{let blob;const oldCreate=URL.createObjectURL,oldClick=HTMLAnchorElement.prototype.click;URL.createObjectURL=b=>{blob=b;return oldCreate.call(URL,b)};HTMLAnchorElement.prototype.click=function(){};try{document.getElementById('prompt_replace_export_current_wavespeed').click()}finally{URL.createObjectURL=oldCreate;HTMLAnchorElement.prototype.click=oldClick}return JSON.parse(await blob.text())})()`);
  assert.deepEqual(exported, { 导入规则: { text: '雨天=替换|rainy day' } }); results.push('export current contains exactly the selected shared preset');
  await select('常用规则');
  await fs.mkdir(root, { recursive: true });
  for (const [name,width,height,mobile] of [['desktop',1280,1100,false],['mobile',390,844,true],['narrow',360,640,true]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await evaluate("document.getElementById('ws-prompt-replace').open=true;document.getElementById('ws-prompt-replace').scrollIntoView({block:'start'})");
    await check(name + ': no horizontal overflow', "(()=>{const c=document.querySelector('.st-chatu8-content');return c.scrollWidth<=c.clientWidth+1})()");
    await evaluate("document.getElementById('prompt_replace_update_style_wavespeed').scrollIntoView({block:'center'})");
    await check(name + ': save button is reachable', "(()=>{const e=document.getElementById('prompt_replace_update_style_wavespeed'),r=e.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===e})()");
    if (name !== 'narrow') { const shot = await call('Page.captureScreenshot'); await fs.writeFile(new URL(name + '.png', root), Buffer.from(shot.data, 'base64')); }
  }
  await fs.writeFile(new URL('result.json', root), JSON.stringify({ passed: true, assertions: results.length, results, realPaidRequests: 0 }, null, 2));
  console.log(`PASS: ${results.length} browser checks: shared preset load/save/reload, new/save-as/rename/delete/import/export, draft protection, both cloud prompt paths and desktop/mobile layout. No real provider requests.`);
} finally { socket.close(); }
