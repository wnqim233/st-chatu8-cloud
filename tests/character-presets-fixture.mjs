// Minimal host for the actual bundled character resolver and production hook.
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createWaveSpeedAdapter} from '../wavespeed/adapter.js';
import {expandCloudCharacters} from '../wavespeed/characters.js';
const source=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
const fn=name=>{const m=new RegExp('(?:async )?function '+name+'\\(').exec(source);return source.slice(m.index,source.indexOf('\n}',m.index)+2)};
export function fixture(){
 const settings={mode:'civitai',characterPresets:{
  hero:{nameCN:'示例男主',nameEN:'Example Hero|Alias',characterTraits:'an adult man, lean athletic build',facialFeatures:'refined face, short black hair',facialFeaturesBack:'short black hair from behind',upperBodySFW:'slim shoulders',upperBodySFWBack:'lean back',negative:'heavy beard'},
  driver:{nameCN:'示例女主',nameEN:'Example Driver',characterTraits:'an adult woman',facialFeatures:'gold rimmed glasses',upperBodySFW:'beige cardigan',negative:'dark sunglasses'},
 },outfitPresets:{coat:{nameCN:'外套',nameEN:'Coat',upperBody:'a blue coat front',upperBodyBack:'a blue coat back'}},characterEnablePresetId:'cast',characterEnablePresets:{cast:{characters:[{characterPresetName:'hero'},'driver']}},outfitEnablePresetId:'clothes',outfitEnablePresets:{clothes:{outfits:['coat']}}};
 const box={console:{log(){},warn(){},error(){}},window:{},extensionName:'st-chatu8-cloud',extension_settings29:{'st-chatu8-cloud':settings},extension_settings115:{'st-chatu8-cloud':settings},createWaveSpeedAdapter,expandCloudCharacters,SillyTavern:{getContext:()=>({chatId:'fixture'})},isPluginEnabled:()=>true,eventSource:{},EventType:{},initializeImageProcessing(){},setItemImg(){},prompt_replace:async p=>({modifiedPrompt:p,insertions:{}}),prompt_replace_for_character:p=>p,parsePromptStringWithCoordinates(){},zhengmian:async(a,b,c)=>[a,b,c].filter(Boolean).join(', '),taskQueue:{},recordImageGeneration(){},addLog(){}};
 vm.createContext(box);vm.runInContext('var waveSpeedAdapterInstance;\n'+['normalizeName','calculateMatchScore','collectCharacterCandidates','collectOutfitCandidates','findBestCharacterMatch','findBestOutfitMatch','processCharacterPrompt','collectNegativeToGlobal','getWaveSpeedAdapter'].map(fn).join('\n'),box);
 return {box,settings,expand:p=>expandCloudCharacters(p,box.processCharacterPrompt,box.window),productionAdapter:()=>box.getWaveSpeedAdapter()};
}
