// Full upstream settings modal; mock credentials and no provider requests.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const targets=await(await fetch('http://127.0.0.1:9234/json/list')).json();
const target=targets.find(t=>t.url.includes('/tests/settings-import.html'));assert.ok(target);
const socket=new WebSocket(target.webSocketDebuggerUrl);let sequence=0;const pending=new Map();
socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}};
await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))});
const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
const until=async(expression,check=Boolean)=>{for(let n=0;n<100;n++){const v=await evaluate(expression);if(check(v))return v;await new Promise(r=>setTimeout(r,100))}throw Error('Timed out')};
const root=new URL('../test-results/mobile-settings/',import.meta.url);await fs.mkdir(root,{recursive:true});
try{
 await call('Page.reload',{ignoreCache:true});await until('globalThis.regression?.result?.passed');
 await evaluate(`(async()=>{const {createSettingsEditor}=await import('/wavespeed/settings.js');const {createBrowserApi}=await import('/wavespeed/browser.js');const s=regression.settings;const api=createBrowserApi({settings:()=>s,saveSettings(){}},{fetcher:()=>{throw Error('Provider request forbidden')}});globalThis.mobileEditor=createSettingsEditor({api,deps:{settings:()=>s,saveSettings(){}},$:id=>document.getElementById('ws-'+id),notify:(t,e)=>{document.getElementById('ws-status').textContent=t},onModeChanged(){}});mobileEditor.mount();document.getElementById('ch-version-display').textContent='v3.1.0-cloud.9';})()`);
 await until('!document.getElementById("ws-form").disabled');
 for(const [width,height] of [[390,844],[360,640],[844,390]]){
  await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
  await evaluate(`document.querySelector('.st-chatu8-content').scrollTop=0`);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.ws-toolbar')).position"),'static');
  const rect=await evaluate(`(()=>{const c=document.querySelector('.st-chatu8-content');return {height:c.clientHeight,width:c.clientWidth,overflow:c.scrollWidth>c.clientWidth+1}})()`);assert.equal(rect.overflow,false);assert.ok(rect.height>120);
  if(width===390){const shot=await call('Page.captureScreenshot');await fs.writeFile(new URL('top.png',root),Buffer.from(shot.data,'base64'));}
  await evaluate(`document.getElementById('ws-civitai-params').scrollIntoView({block:'start'})`);
  const hit=await evaluate(`(()=>{const el=document.getElementById('ws-civitai-params'),r=el.getBoundingClientRect(),c=document.querySelector('.st-chatu8-content').getBoundingClientRect();return {visible:document.elementFromPoint(r.left+20,Math.max(r.top,c.top)+30)===el,toolbarBottom:document.querySelector('.ws-toolbar').getBoundingClientRect().bottom,contentTop:c.top}})()`);assert.equal(hit.visible,true);assert.ok(hit.toolbarBottom<hit.contentTop);
  if(width===390){const shot=await call('Page.captureScreenshot');await fs.writeFile(new URL('json.png',root),Buffer.from(shot.data,'base64'));}
 }
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await evaluate(`(()=>{const el=document.getElementById('ws-civitai-params');const p=JSON.parse(el.value);p.loras={'urn:air:krea2:lora:civitai:111@222':0.45};el.value=JSON.stringify(p,null,2);el.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-ws-save="civitai"]').scrollIntoView({block:'center'});document.querySelector('[data-ws-save="civitai"]').click()})()`);
 await until(`document.querySelector('[data-ws-save-state="civitai"]').textContent.startsWith('已保存')`);
 assert.deepEqual((await evaluate('regression.cloudConfig()')).civitaiParams.loras,{'urn:air:krea2:lora:civitai:111@222':0.45});
 const shot=await call('Page.captureScreenshot');await fs.writeFile(new URL('saved.png',root),Buffer.from(shot.data,'base64'));
 await evaluate(`(()=>{const el=document.getElementById('ws-civitai-params');el.value='{invalid';el.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-ws-save="civitai"]').click()})()`);
 await until(`document.querySelector('[data-ws-save-state="civitai"]').textContent.includes('JSON 格式错误')`);
 assert.deepEqual((await evaluate('regression.cloudConfig()')).civitaiParams.loras,{'urn:air:krea2:lora:civitai:111@222':0.45});
 console.log('PASS: full modal at 390x844, 360x640, 844x390; toolbar scrolls away, JSON hit target unobscured, no horizontal overflow, inline save persists exact LoRA, invalid JSON shows local error without replacing saved data.');
}finally{socket.close()}
