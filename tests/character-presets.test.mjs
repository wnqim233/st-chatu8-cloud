import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './character-presets-fixture.mjs';
import {createWaveSpeedAdapter} from '../wavespeed/adapter.js';
import {expandCloudCharacters} from '../wavespeed/characters.js';
const config={imageModel:'urn:air:krea2:diffusionmodel:civitai:100@200+300',imageParams:{width:1024,height:1024,steps:8,cfgScale:1,scheduler:'simple',loras:{}},dimensionSource:'json',sizeMode:'width_height',negativeField:'negativePrompt'};

test('real production hook expands preset faces before Civitai submission',async()=>{
 const {productionAdapter}=fixture();
 const result=await productionAdapter().prepare({prompt:'A car. $示例男主-sfw-upperbody$, seated in the passenger seat.'},config);
 assert.match(result.prompt,/refined face, short black hair/);assert.match(result.prompt,/passenger seat/);
 assert.doesNotMatch(result.prompt,/\$/);assert.equal(result.params.negativePrompt,'heavy beard');
 assert.equal(result.params.scheduler,'simple');assert.equal(result.params.width,1024);assert.deepEqual(result.params.loras,{});
});

test('structured roles preserve multiline descriptions, separate cast traits, and exclude UC from positive text',async()=>{
 const {productionAdapter,box}=fixture();box.window.collectedCharacterNegatives='unrelated UI state';
 const result=await productionAdapter().prepare({prompt:'Scene Composition:car interior, 768x512;\nCharacter 1 Prompt:$示例女主-sfw-upperbody$, driving\nwith both hands on the wheel; looking aside|centers:a1; Character 1 UC:bad lighting;\nCharacter 2 Prompt:$示例男主-sfw-upperbody$, sitting\nin the passenger seat|centers:;'},config);
 assert.match(result.prompt,/gold rimmed glasses, beige cardigan, driving\nwith both hands on the wheel; looking aside/);
 assert.match(result.prompt,/refined face, short black hair, slim shoulders, sitting\nin the passenger seat/);
 assert.doesNotMatch(result.prompt,/centers|768x512|bad lighting|heavy beard|\$/);
 assert.equal(result.params.negativePrompt,'dark sunglasses, heavy beard');
 assert.equal(box.window.collectedCharacterNegatives,'unrelated UI state');
});

test('JSON character and outfit markers share viewing angle inside their role only',async()=>{
 const {productionAdapter}=fixture();
 const back='${"name":"Example Hero","angle":"from behind","upperBody":"sfw","lowerBody":"hidden"}$';
 const coat='${"name":"Coat","upperBody":"visible","lowerBody":"hidden"}$';
 const result=await productionAdapter().prepare({prompt:`Scene Composition:street; Character 1 Prompt:${back}, ${coat}; Character 2 Prompt:${coat};`},config);
 assert.match(result.prompt,/short black hair from behind, lean back, a blue coat back/);
 assert.match(result.prompt,/\n\na blue coat front$/);assert.doesNotMatch(result.prompt,/refined face/);
});

test('aliases resolve while natural text, bare names and missing characters stay unchanged',()=>{
 const {expand}=fixture();
 assert.match(expand('$Alias-sfw-upperbody$').prompt,/refined face/);
 for(const text of ['示例男主 looks at the road.','$示例男主$','$Missing-sfw-upperbody$','Scene Composition:line one\nline two; continued'])assert.equal(expand(text).prompt,text);
});

test('expansion restores shared negative state on success and on failure',()=>{
 const {expand,box}=fixture();
 const result=expand('$示例男主-sfw-upperbody$');assert.equal(result.negative,'heavy beard');
 assert.equal(Object.hasOwn(box.window,'collectedCharacterNegatives'),false);
 const state={collectedCharacterNegatives:'preserved'};
 assert.throws(()=>expandCloudCharacters('$name$',()=>{state.collectedCharacterNegatives='temporary';throw Error('resolver failed')},state),/resolver failed/);
 assert.equal(state.collectedCharacterNegatives,'preserved');
 assert.equal(expand('plain prose').negative,'');
});

test('old backend resolver keeps its original default normalization',()=>{
 const {box}=fixture();
 assert.equal(box.processCharacterPrompt('line one\nline two, , $Alias-sfw-upperbody$'),'line one, line two, an adult man, lean athletic build, refined face, short black hair, slim shoulders');
 assert.equal(box.window.collectedCharacterNegatives,'heavy beard');
});

test('generation and prompt copy reuse preset expansion, and history keeps its actual old prompt',async()=>{
 const {expand,settings}=fixture(),history=[];
 const adapter=createWaveSpeedAdapter({expandCharacters:expand,settings:()=>settings,context:()=>({chatId:'fixture'}),api:async route=>route==='/jobs'?history:{...config,civitaiModel:config.imageModel,civitaiParams:config.imageParams},replacePrompt:async p=>({modifiedPrompt:p.replace('short black hair','neatly styled black hair'),insertions:{}}),replaceCharacter:p=>p,composePrompt:async(a,b,c)=>[a,b,c].filter(Boolean).join(', ')});
 const request={prompt:'$Alias-sfw-upperbody$, seated.'};
 const result=await adapter.prepare(request,config);assert.match(result.prompt,/neatly styled black hair/);
 assert.equal((await adapter.promptForCopy(request)).text,result.prompt);
 history.push({source:{chatId:JSON.stringify(['chat','fixture'])},cacheTag:request.prompt,prompt:'historical actual prompt',createdAt:1});
 assert.equal((await adapter.promptForCopy(request)).text,'historical actual prompt');
});

test('parallel preparations and fixed prefixes keep character negatives separate',async()=>{
 const {productionAdapter,box}=fixture();const adapter=productionAdapter();
 const [male,female,plain]=await Promise.all([adapter.prepare({prompt:'$Alias-sfw-upperbody$'},config),adapter.prepare({prompt:'$示例女主-sfw-upperbody$'},config),adapter.prepare({prompt:'landscape'},config)]);
 assert.equal(male.params.negativePrompt,'heavy beard');assert.equal(female.params.negativePrompt,'dark sunglasses');assert.equal(plain.params.negativePrompt,undefined);
 const fixed=await adapter.prepare({prompt:'walking'}, {...config,fixedPrompt:'$Alias-sfw-upperbody$',fixedPromptEnd:'$Alias-sfw-upperbody$'});
 assert.match(fixed.prompt,/refined face/);assert.equal(fixed.params.negativePrompt,'heavy beard');
 assert.equal(Object.hasOwn(box.window,'collectedCharacterNegatives'),false);
});
