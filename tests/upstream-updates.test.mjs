import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
const quiet = { log() {}, warn() {}, error() {}, group() {}, groupEnd() {} };
function moduleSource(name) {
  const marker = '// ' + name + '\n', start = source.lastIndexOf(marker);
  assert.ok(start >= 0, name);
  const next = /^\/\/ [a-zA-Z][^\n]*\.(?:js|ts)\s*$/m.exec(source.slice(start + marker.length));
  return source.slice(start, next ? start + marker.length + next.index : source.length);
}
function fn(name, text = source) {
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(text);
  assert.ok(match, name);
  const end = text.indexOf('\n}', match.index);
  assert.ok(end > match.index, name);
  return text.slice(match.index, end + 2);
}
function context(text, settings = {}, extra = {}) {
  const box = { console:quiet, extensionName:'st-chatu8-cloud', addLog() {}, ...extra };
  for(const name of new Set(text.match(/\bextension_settings\d*\b/g) || [])) box[name] = { 'st-chatu8-cloud':settings };
  vm.createContext(box);
  return box;
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('regex rules support captures, character replacement, legacy literals and invalid-pattern fallback', async () => {
  const text = source.slice(source.indexOf('function parseReWrapper('), source.indexOf('function getRequestHeaders(', source.indexOf('function parseReWrapper(')));
  const settings = { prompt_replace_id:'test', prompt_replace:{test:{text:'re(eyes:(blue|green))=替换|re($1 eyes)\n白发=替换|silver hair\nre(coat:(red|black))=后置后|re($1 coat)'}} };
  const box = context(text, settings, { extractIfCondition:value=>({value:value.trim(),condition:null}), safeEvaluateIf:()=>true });
  vm.runInContext(text, box);
  const result = await box.prompt_replace('白发, eyes:blue, coat:red');
  assert.equal(result.modifiedPrompt, 'silver hair, blue eyes, coat:red');
  assert.equal(result.insertions['后置后'], 'red coat');
  assert.equal(box.prompt_replace_for_character('白发, eyes:green', ''), 'silver hair, green eyes');
  settings.prompt_replace.test.text = 're([)=替换|bracket';
  assert.equal((await box.prompt_replace('a [ sign')).modifiedPrompt, 'a bracket sign');
});

test('insertion matching removes headers before content while preserving ordinary unwrapped text', () => {
  const text = fn('getImageTags') + '\n' + fn('removeThinkingText') + '\n' + fn('removeThinkingTextOnly');
  const box = context(text); vm.runInContext(text, box);
  const input = '<think>header repeated line</think>header repeated line<content>body repeated line</content>';
  for(const f of ['removeThinkingText','removeThinkingTextOnly']) {
    assert.equal(box[f](input), 'body repeated line</content>');
    assert.equal(box[f]('ordinary story line'), 'ordinary story line');
  }
});

test('old cached JPEG/WebP/PNG/GIF records retain their real type when read by UUID', async () => {
  const text = ['formatToMimeType','detectMimeFromBuffer','getImageByUUID','getImageBlobByUUID'].map(name=>fn(name)).join('\n');
  let bytes;
  const box = context(text, {}, { Uint8Array, Blob, storeReadOnly:async()=>({data:bytes}), arrayBufferToBase64:data=>Buffer.from(data).toString('base64') });
  vm.runInContext(text, box);
  for(const [mime, data] of [
    ['image/jpeg',[255,216,255,224]], ['image/png',[137,80,78,71,13,10,26,10]],
    ['image/gif',[71,73,70,56]], ['image/webp',[82,73,70,70,0,0,0,0,87,69,66,80]],
  ]) {
    bytes=Uint8Array.from(data);
    assert.ok((await box.getImageByUUID('legacy')).startsWith('data:'+mime+';base64,'));
    assert.equal((await box.getImageBlobByUUID('legacy')).type,mime);
  }
  assert.equal(box.formatToMimeType('jpg'),'image/jpeg');
  assert.equal(box.detectMimeFromBuffer(Uint8Array.from([26,69,223,163]),true),'video/webm');
});

function pregenFixture(mode='civitai', read=async()=>[null]) {
  const text=moduleSource('utils/pregen_manager.js');
  const bus=new EventEmitter(), active=new Set(), timers=new Map(), requests=[];
  bus.on('request',req=>requests.push(req));
  const settings={mode,aiAutonomousResolution:'true'};
  const box=context(text,settings,{
    normalizePromptTag:s=>s.trim(), getItemImg:read, isGenerating:p=>active.has(p),
    startGenerating:p=>active.add(p), stopGenerating:p=>active.delete(p), registerAutoClickHandled() {},
    clearAllGenerating(){throw new Error('Must not reset other tasks');},
    EventType:{GENERATE_IMAGE_REQUEST:'request',GENERATE_IMAGE_RESPONSE:'response'},
    setTimeout:(cb,ms)=>{const id={};timers.set(id,{cb,ms});return id;},clearTimeout:id=>timers.delete(id),
  });
  for(const name of new Set(text.match(/\beventSource\d*\b/g)||[]))box[name]=bus;
  for(const name of new Set(text.match(/\binit_\w+(?=\(\);)/g)||[]))box[name]=()=>{};
  vm.runInContext(text,box);
  return {box,bus,active,timers,requests};
}

for(const mode of ['civitai','wavespeed']) test(`${mode} pregen survives resets and queues longer than three minutes without duplicate submission`,async()=>{
  const f=pregenFixture(mode);
  f.box.pregenManager.add(['landscape, 768x1024','landscape, 768x1024','forest']);
  await flush();assert.equal(f.requests.length,2);assert.equal(f.timers.size,0,'cloud adapter owns queued time and timeout');
  assert.equal(f.requests[0].width,'768');assert.equal(f.requests[0].height,'1024');
  f.box.pregenManager.clear();
  f.box.pregenManager.add(['landscape, 768x1024']);await flush();
  assert.equal(f.requests.length,2);assert.equal(f.bus.listenerCount('response'),2);
  for(const req of f.requests) f.bus.emit('response',{id:req.id,success:true});
  assert.equal(f.active.size,0);assert.equal(f.bus.listenerCount('response'),0);
});

test('pregen stop invalidates an unfinished cache lookup before any remote submission',async()=>{
  let finish;
  const f=pregenFixture('civitai',()=>new Promise(resolve=>{finish=resolve;}));
  f.box.pregenManager.add(['unsent']);f.box.pregenManager.clear();finish([null]);await flush();
  assert.equal(f.requests.length,0);assert.equal(f.bus.listenerCount('response'),0);
});

test('pregen reuses an existing cached image and retains timeout cleanup for old backends',async()=>{
  const cached=pregenFixture('civitai',async()=>['data:image/png;base64,AA==']);
  cached.box.pregenManager.add(['cached']);await flush();assert.equal(cached.requests.length,0);
  const other=pregenFixture('novelai');other.box.pregenManager.add(['slow']);await flush();
  assert.equal(other.timers.size,1);const timer=[...other.timers.values()][0];assert.equal(timer.ms,180000);
  timer.cb();assert.equal(other.active.size,0);assert.equal(other.bus.listenerCount('response'),0);
});

test('stream parsing ignores closed/open/partial thinking blocks and keeps final image work alive',()=>{
  const text=moduleSource('utils/settings/stream_generate.js'),bus=new EventEmitter(), added=[];let clears=0;
  const box=context(text,{enablePregen:'true',startTag:'[prompt]',endTag:'[/prompt]'},{init_utils(){},normalizePromptTag:s=>s.trim(),pregenManager:{clear(){clears++;},add:p=>added.push(...p)}});
  const types={GENERATION_STARTED:'start',GENERATION_STOPPED:'stop',GENERATION_ENDED:'end',CHAT_CHANGED:'chat',STREAM_TOKEN_RECEIVED:'token'};
  for(const name of new Set(text.match(/\beventSource\d*\b/g)||[]))box[name]=bus;
  for(const name of new Set(text.match(/\bevent_types\d*\b/g)||[]))box[name]=types;
  vm.runInContext(text,box);
  for(const tag of ['think','thinking','thought']) {
    assert.deepEqual(Array.from(box.parsePrompts(`<${tag}>[prompt]hidden[/prompt]</${tag}>[prompt]visible[/prompt]`)),['visible']);
    assert.equal(box.parsePrompts(`<${tag}>[prompt]hidden[/prompt]`).length,0);
  }
  assert.equal(box.parsePrompts('<think>[prompt]hidden[/prompt]</thi').length,0);
  bus.emit('start');bus.emit('token','[prompt]final[/prompt]');bus.emit('end');
  assert.deepEqual(added,['final']);assert.equal(clears,1);
  bus.emit('stop');bus.emit('chat');assert.equal(clears,3);
});

test('manual requests keep their demand dialog; automatic requests skip it without changing the preference',async()=>{
  const text=fn('processImageLikeRequest');let popups=0;const reachedContext=new Error('context reached');
  const settings={imageGenDemandEnabled:true,defaultImageDemand:'soft light'};
  const box=context(text,settings,{debugTimer:()=>({end(){}}),debugMilestone(){},debugLog(){},debugBranch(){},toastr:{info(){}},showUserDemandPopup2:async()=>{popups++;return null;}});
  for(const name of new Set(text.match(/\bgetContext\d*\b/g)||[]))box[name]=()=>{throw reachedContext;};
  vm.runInContext(text,box);
  await box.processImageLikeRequest({},'gesture1','image_gen','image',()=>{});
  assert.equal(popups,1);
  await assert.rejects(box.processImageLikeRequest({},'gesture1','image_gen','image',()=>{},{source:'auto'}),error=>error===reachedContext);
  assert.equal(popups,1);assert.equal(settings.imageGenDemandEnabled,true);
});

test('image rendering errors and cross-origin frames still release the correct loading button',()=>{
  const module=moduleSource('utils/iframe/generation.js');
  const start=module.indexOf('        const imageResponseHandler = (responseData) => {');
  const end=module.indexOf('        trackImageResponseHandler(requestId, imageResponseHandler);',start);
  const text=fn('getImageResponseDocuments',module)+'\n'+module.slice(start,end)+'\nglobalThis.handler=imageResponseHandler;';
  const attributes=new Set(['data-loading']);const button={dataset:{loadingStartedAt:'1'},disabled:true,style:{setProperty(){}},removeAttribute:name=>attributes.delete(name),matches:()=>true};
  const span={previousElementSibling:button};let released=0,untracked=0;
  const document={querySelectorAll:selector=>selector==='iframe'?[{get contentDocument(){throw new Error('cross origin');}}]:selector.startsWith('span')?[span]:[button]};
  const box=context(text,{dbclike:'false'},{document,requestId:'request-1',link:'landscape',stopGenerating(){released++;},untrackImageResponseHandler(){untracked++;},createAndShowImage(){throw new Error('render failure');},toastr:{error(){}},setTimeout(){}});
  vm.runInContext(text,box);
  box.handler({id:'other',success:true,imageData:'data:image/png;base64,AA=='});assert.equal(button.disabled,true);
  box.handler({id:'request-1',success:true,imageData:'data:image/png;base64,AA=='});
  assert.equal(button.disabled,false);assert.equal(attributes.has('data-loading'),false);
  assert.equal(button.dataset.loadingStartedAt,undefined);assert.equal(untracked,1);assert.ok(released>0);
});
