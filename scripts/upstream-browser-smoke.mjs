// Uses real browser DOM and the shipped bundle functions; no generation API.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const targets=await(await fetch('http://127.0.0.1:9234/json/list')).json();
const target=targets.find(t=>t.url.startsWith('http://127.0.0.1:8765/tests/'));
assert.ok(target,'Open the local preview in isolated Chrome on port 9234');
const socket=new WebSocket(target.webSocketDebuggerUrl);let sequence=0;const pending=new Map();
socket.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}};
await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))});
const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
try{
 await call('Emulation.setDeviceMetricsOverride',{width:1100,height:1200,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url:'http://127.0.0.1:8765/tests/upstream-browser.html'});
 let result;
 for(let attempt=0;attempt<100;attempt++){result=await evaluate('globalThis.upstreamRegression');if(result)break;await new Promise(r=>setTimeout(r,100))}
 assert.equal(result?.passed,true,JSON.stringify(result));
 const root=new URL('../test-results/upstream-browser/',import.meta.url);await fs.mkdir(root,{recursive:true});
 await fs.writeFile(new URL('result.json',root),JSON.stringify(result,null,2));
 const shot=await call('Page.captureScreenshot');await fs.writeFile(new URL('result.png',root),Buffer.from(shot.data,'base64'));
 console.log(`PASS: ${result.checks.length} browser assertions; repeated header/thinking text never captures the body image; ordinary insertion, chat save and redraw, legacy JPEG/WebP/PNG decoded. No generation API requests.`);
}finally{socket.close()}
