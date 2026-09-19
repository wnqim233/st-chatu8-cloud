import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createBrowserApi, BrowserStore, detectImage } from '../wavespeed/browser.js';
import { DEFAULT_CONFIG } from '../shared/config.js';

// Persistence and Blob URLs use the real IndexedDB in browser_smoke.py.
// This fake is only for transport routing, secret handling and provider reuse.
function memoryStore() {
  const data = new Map();
  const store = new BrowserStore('unit-test', { locks: undefined });
  store.config = async () => ({ ...structuredClone(DEFAULT_CONFIG), ...data.get('config') });
  store.saveConfig = async value => data.set('config', structuredClone(value));
  store.jobs = async () => structuredClone(data.get('jobs') || []);
  store.saveJob = async job => { const jobs = await store.jobs(); data.set('jobs', [...jobs.filter(j => j.id !== job.id), structuredClone(job)]); return job; };
  store.expose = async job => structuredClone(job);
  return store;
}

test('browser transport calls provider directly, without /api/plugins, and persists config per installation', async () => {
  const settings = {}; let saves = 0; const stores = new Map(); const requests = [];
  const deps = { settings: () => settings, saveSettings: () => saves++ };
  const api = createBrowserApi(deps, { storeFactory: id => { if (!stores.has(id)) stores.set(id, memoryStore()); return stores.get(id); }, fetcher: async (url, opts) => {
    requests.push(url); assert.ok(url.startsWith('https://api.wavespeed.ai/')); assert.equal(opts.headers.Authorization, 'Bearer browser-fake-key'); assert.equal(opts.credentials, 'omit');
    return new Response(JSON.stringify({ code: 200, data: { id: 'direct-task', status: 'created' } }));
  } });
  const saved = await api('/config', { wavespeedKey: 'browser-fake-key' });
  assert.equal(saved.hasWavespeedKey, true); assert.equal(saved.wavespeedKey, undefined); assert.equal(saves, 1);
  const input = { id: 'browser-request-0001', provider: 'wavespeed', prompt: 'a tree', source: { chatId: 'c', messageId: 'm', hash: 'h' } };
  const job = await api('/jobs', input); assert.equal(job.taskId, 'direct-task');
  await api('/jobs', input); assert.equal(requests.length, 1);
  const previousScope = settings.cloudStorageId; delete settings.cloudStorageId;
  assert.equal((await api('/config')).hasWavespeedKey, false); assert.notEqual(previousScope, settings.cloudStorageId);
});

test('independent upstream settings, image databases and events do not use original identities', async () => {
  const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf('    extensionName = '); const end = source.indexOf('    LLMRequestTypes = ', start);
  const sandbox = { URL, extensionName: undefined, extensionFolderPath: undefined, EventType: undefined, eventNames: undefined };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end).replace('import.meta.url', '"https://tavern.example/scripts/extensions/third-party/custom-repo/index.js"'), sandbox);
  assert.equal(sandbox.extensionName, 'st-chatu8-cloud');
  assert.equal(sandbox.extensionFolderPath, '/scripts/extensions/third-party/custom-repo');
  assert.notEqual(sandbox.EventType.GENERATE_IMAGE_REQUEST, 'generate-image-request');
  assert.ok(Object.values(sandbox.eventNames).every(name => name.startsWith('cloud-')));
  for (const declaration of ['oldDbName = "chatu8_cloud_legacy"', 'dbName = "chatu8_cloud_gallery"', 'CONFIG_DB_NAME = "chatu8_cloud_config_images"', 'STEGO_FOLDER = "chatu8CloudList"']) assert.ok(source.includes(declaration));
  assert.ok(!source.includes('oldDbName = "tupian"')); assert.ok(!source.includes('window.chatu8_old_settings'));
});

test('browser image cache recognizes actual bytes and refuses an HTML error page', () => {
  assert.equal(detectImage(Uint8Array.from([137,80,78,71,13,10,26,10])), 'png');
  assert.throws(() => detectImage(new TextEncoder().encode('<html>Forbidden</html>')), /不是/);
});

test('original chat metadata helpers write only the independent plugin namespace', async () => {
  const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function setcharData('); const end = source.indexOf('async function getElContext(', start);
  const context = { chatMetadata: { 'st-chatu8': { data: { character: 'original' } } } }; let saves = 0;
  const sandbox = { getContext2: () => context, saveChatConditional2: () => saves++ };
  vm.createContext(sandbox); vm.runInContext(source.slice(start, end), sandbox);
  await sandbox.setcharData('character', 'cloud');
  assert.equal(await sandbox.getcharData('character'), 'cloud'); assert.equal(context.chatMetadata['st-chatu8'].data.character, 'original'); assert.equal(saves, 1);
  assert.ok(!source.includes('["st-chatu8"]'));
});

test('browser follows Civitai blob redirects without credentials and caches the actual image', async () => {
  const store = new BrowserStore('redirect-test'); const saved=[];
  store.write=async (key,blob)=>saved.push({key,blob});
  const png=Uint8Array.from([137,80,78,71,13,10,26,10]);
  const result=await store.download('https://orchestration-new.civitai.com/blobs/test','recovered-image',async (url,opts)=>{
    assert.equal(opts.redirect,'follow'); assert.equal(opts.credentials,'omit'); assert.equal(opts.headers,undefined);
    const response=new Response(png);Object.defineProperty(response,'url',{value:'https://orchestration-new.civitai.com/signed/image'});return response;
  });
  assert.equal(result,'recovered-image');assert.equal(saved[0].blob.type,'image/png');assert.equal(saved[0].blob.size,8);
});

test('browser keeps redirect blocking for other hosts and rejects foreign Civitai redirect results', async () => {
  const store = new BrowserStore('redirect-test');store.write=async ()=>{};
  const png=Uint8Array.from([137,80,78,71,13,10,26,10]);
  await store.download('https://images.example/test','image',async (url,opts)=>{assert.equal(opts.redirect,'error');return new Response(png);});
  await assert.rejects(store.download('https://orchestration-new.civitai.com/blobs/test','image',async ()=>{
    const response=new Response(png);Object.defineProperty(response,'url',{value:'https://example.net/image'});return response;
  }),/非预期地址/);
});

test('cloud settings transfer restores model and LoRAs but preserves target credentials', async () => {
  const { createWaveSpeedAdapter } = await import('../wavespeed/adapter.js');
  const sourceStore=memoryStore(), targetStore=memoryStore();
  const sourceSettings={cloudStorageId:'source'},targetSettings={cloudStorageId:'target'};
  const sourceApi=createBrowserApi({settings:()=>sourceSettings},{storeFactory:()=>sourceStore});
  const targetApi=createBrowserApi({settings:()=>targetSettings},{storeFactory:()=>targetStore});
  await sourceApi('/config',{civitaiKey:'source-secret',civitaiModel:'urn:air:krea2:diffusionmodel:civitai:2735032@3248918',civitaiParams:{width:640,height:960,steps:8,cfgScale:1,sampler:'euler',scheduler:'beta',quantity:1,loras:{'urn:air:krea2:lora:civitai:2742129@3083986':0.8}},civitaiMaxBuzz:70});
  await targetApi('/config',{civitaiKey:'target-secret'});
  const source=createWaveSpeedAdapter({api:sourceApi}),target=createWaveSpeedAdapter({api:targetApi});
  const backup=JSON.parse(JSON.stringify(await source.exportConfig()));
  assert.equal(JSON.stringify(backup).includes('source-secret'),false);
  backup.config.civitaiKey='malicious-replacement';backup.config.clear_civitaiKey=true;
  await target.importConfig(backup);
  const restored=await targetStore.config();
  assert.equal(restored.civitaiKey,'target-secret');assert.equal(restored.civitaiMaxBuzz,70);
  assert.deepEqual(restored.civitaiParams,(await sourceStore.config()).civitaiParams);
  assert.equal(restored.civitaiModel,(await sourceStore.config()).civitaiModel);
  assert.equal(targetSettings.cloudStorageId,'target');assert.deepEqual(await targetStore.jobs(),[]);
  await target.importConfig(undefined);
  await assert.rejects(target.importConfig({version:2,config:{}}),/版本/);
  await assert.rejects(target.importConfig({version:1,config:[]}),/JSON 对象/);
  assert.equal((await targetStore.config()).civitaiKey,'target-secret');
});


test('saved LoRA replacements and deletions reach the Civitai workflow exactly; revisions advance', async () => {
  const { providerConfig, mapParameters } = await import('../wavespeed/client.js');
  const store = memoryStore(); const paid = [], estimates = [];
  const api = createBrowserApi({ settings: () => ({cloudStorageId:'lora-save-test'}) }, {storeFactory:()=>store,fetcher:async(url,options)=>{
    const body=JSON.parse(options.body);
    if(url.includes('whatif')) {estimates.push(body);return new Response(JSON.stringify({cost:{total:1}}));}
    paid.push(body);return new Response(JSON.stringify({id:'lora-'+paid.length,status:'succeeded',steps:[]}));
  }});
  const a='urn:air:krea2:lora:civitai:100@200',b='urn:air:krea2:lora:civitai:101@201';
  const params={width:1024,height:1024,steps:8,cfgScale:1,sampler:'euler',scheduler:'beta',loras:{[a]:0.7}};
  let config=await api('/config',{civitaiKey:'fake-key',civitaiModel:'urn:air:krea2:diffusionmodel:civitai:1000@2000',civitaiParams:params});
  for (const [i,loras] of [{[a]:0.3,[b]:0.9},{[b]:0.5},{}].entries()) {
    const revision=config.revision;
    config=await api('/config',{civitaiParams:{...params,loras}});
    assert.equal(config.revision,revision+1);
    const actual=mapParameters(providerConfig(await api('/config'),'civitai'),{width:512,height:768});
    assert.equal(actual.width,1024,'JSON dimensions win by default');
    await api('/jobs',{id:'lora-save-request-'+i,provider:'civitai',prompt:'same landscape prompt',params:actual,model:config.civitaiModel,configRevision:config.revision,source:{chatId:'c',messageId:'m',hash:'h'}});
    assert.deepEqual(paid[i].steps[0].input.loras,loras);
    assert.deepEqual(estimates[i].steps,paid[i].steps);
    assert.deepEqual((await api('/config')).civitaiParams.loras,loras);
  }
  assert.equal(paid.length,3,'changing LoRAs does not reuse a previous request');
  assert.equal(JSON.stringify(await api('/config')).includes('fake-key'),false);
});

test('invalid saves preserve old parameters and dimension source can explicitly follow the button', async () => {
  const {providerConfig,mapParameters}=await import('../wavespeed/client.js');
  const store=memoryStore(); const api=createBrowserApi({settings:()=>({cloudStorageId:'validation-save'})},{storeFactory:()=>store});
  const before=await api('/config');
  await assert.rejects(api('/config',{civitaiParams:{...before.civitaiParams,unsupportedLoraField:{}}}),/不支持/);
  assert.deepEqual(await api('/config'),before);
  const after=await api('/config',{dimensionSource:'request'});
  assert.equal(mapParameters(providerConfig(after,'civitai'),{width:512,height:768}).height,768);
});
