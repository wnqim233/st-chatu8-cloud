import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { parseImageReply, imageReplyFailureInfo } from '../shared/image-reply.js';
import { imageFooterOffset, retainImageDrafts, promoteImageDraft } from '../shared/image-footer.js';

const xml = (anchor, prompt) => `<image><regex>${anchor}</regex><prompts>${prompt}</prompts></image>`;

test('five standalone XML images are kept in order without the outer wrapper', () => {
  const anchors = ['她推开窗。', '外面下着雨。', '树叶开始晃动。', '窗台上有一只鸟。', '远处的灯亮了。'];
  const text = anchors.map((anchor, i) => xml(anchor, `scene ${i + 1}`)).join('\n');
  assert.deepEqual(parseImageReply(text).images, anchors.map((regex, i) => ({ regex, tag: `image###scene ${i + 1}###` })));
});

test('new XML and legacy markers can coexist across containers, with custom output delimiters', () => {
  const text = `<images>${xml('first', 'warm，window')}<IMAGE id="2">ReGeX ：second\nIMAGE ＃＃＃river＃＃＃</IMAGE></images>
    <IMAGES><image><regex>third</regex><prompt>bird</prompt></image><image>regex:fourth\n[画]cloud[/画]</image></IMAGES>`;
  const { images } = parseImageReply(text, { startTag: '[画]', endTag: '[/画]' });
  assert.deepEqual(images, [ ['first', 'warm, window'], ['second', 'river'], ['third', 'bird'], ['fourth', 'cloud'] ]
    .map(([regex, prompt]) => ({ regex, tag: `[画]${prompt}[/画]` })));
});

test('structured scene, size and character fields survive conversion; echo never substitutes for a payload', () => {
  const text = `<images><image><regex>窗，亮了。</regex><title_styled>黄昏</title_styled>
    <Tag_think>example: <image>image###ignored###</image></Tag_think><size>portrait，768x1024</size>
    <prompts><scene_composition>sunset,</scene_composition><character_1><prompt>traveler</prompt><centers>0.3,0.4</centers><uc>blurry</uc></character_1></prompts></image>
    <image><regex>title only</regex><title_styled>no prompt</title_styled></image></images>`;
  const expected = 'image###Scene Composition:sunset, 768x1024;\nCharacter 1 Prompt:traveler|centers:0.3, 0.4;\nCharacter 1 UC:blurry;###';
  const plain = parseImageReply(text), echo = parseImageReply(text, { tagthinkEcho: true });
  assert.deepEqual(plain.images, [{ regex: '窗，亮了。', tag: expected }]);
  assert.equal(echo.totalBlocks, 2); assert.equal(echo.missingPrompt, 1);
  assert.equal(echo.images[0].tag, '<font color="steelblue">[黄昏]</font>\n' + expected);
  const normalEcho = parseImageReply(text.replace('example: <image>image###ignored###</image>', '晚霞映在窗户上'), { tagthinkEcho: true });
  assert.ok(normalEcho.images[0].tag.includes('<Tag_think>晚霞映在窗户上</Tag_think>'));
});

test('orphan prompts go to the footer; anchor-only and truncated blocks remain editable without borrowing fields', () => {
  const text = `<image><regex>orphan anchor</regex><image><prompts>orphan prompt</prompts></image>
    ${xml('good', 'forest')}<image>regex:cut off\nimage###unfinished`;
  const report = parseImageReply(text);
  assert.deepEqual(report.images, [{regex:'',tag:'image###orphan prompt###',placement:'bottom'}, { regex: 'good', tag: 'image###forest###' }]);
  assert.deepEqual(report.drafts, ['<regex>orphan anchor</regex>', 'regex:cut off\nimage###unfinished']);
  assert.equal(report.footerCount, 1); assert.equal(report.missingPrompt, 2);
  assert.equal(report.missingAnchor, 1); assert.equal(report.incompleteBlocks, 2);
  assert.deepEqual(parseImageReply(xml('anchor', '   ')).images, []);
  assert.equal(parseImageReply(xml('   ', 'blue')).images[0].placement, 'bottom');
});

test('unwrapped tag lists and labeled descriptions become footer prompts; ambiguous or unsafe fragments stay text', () => {
  const report = parseImageReply('<image>sunset， warm light</image><image>提示词：街角的路灯。</image><image><b>unsure</b></image>');
  assert.deepEqual(report.images.map(row => row.tag), ['image###sunset, warm light###','image###街角的路灯。###']);
  assert.ok(report.images.every(row => row.placement === 'bottom')); assert.deepEqual(report.drafts,['<b>unsure</b>']);
});

test('thinking, HTML comments, and examples outside the payload are not emitted as drawing requests', () => {
  const fake = xml('hidden', 'must not generate'), good = xml('real', 'landscape');
  const text = `<think>${fake}</think><!--${fake}-->example: ${fake}\n<images>${good}</images><thought>${fake}`;
  assert.deepEqual(parseImageReply(text).images, [{ regex: 'real', tag: 'image###landscape###' }]);
});

test('bounded legacy repairs work without merging items or completing a truncated reply', () => {
  const text = '<images><table><tr>regex: one\nimage###sky###</tr><tr>regex: two\nimage###hill###</tr></table><\\images>'
    + '<images><image><imgthink>regex: three</imgthink>\nimage###lake<\\image></images>';
  assert.deepEqual(parseImageReply(text).images.map(row => [row.regex, row.tag]),
    [['one', 'image###sky###'], ['two', 'image###hill###'], ['three', 'image###lake###']]);
  assert.deepEqual(parseImageReply('<image>regex: truncated\nimage###unclosed').images, []);
});

// Exercise the actual request owner, including configured retries and insertion.
// The model returns fixture text; no network calls or image generation take place.
const bundle = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
function bundledFunction(name) {
  const start = new RegExp(`(?:async )?function ${name}\\(`).exec(bundle).index;
  return bundle.slice(start, bundle.indexOf('\n}', start) + 2);
}
async function request(replies, retries) {
  const warnings = [], inserted = []; let calls = 0;
  const message = {mes:'story', swipe_id:0};
  const noop = () => {}, empty = () => '', settings = { llm_retry_count: retries };
  const box = {
    parseImageReply, imageReplyFailureInfo, extensionName: 'test', extension_settings11: { test: settings }, extension_settings40: { test: settings },
    debugTimer: () => ({end: noop}), debugMilestone: noop, debugLog: noop, debugBranch: noop, debugError: noop, addLog: noop,
    toastr: { info: noop, success: noop, warning: (...args) => warnings.push(args) }, console: { log: noop, error: noop },
    getContext12: () => ({chatMetadata: {}}), getElContext: () => ['story'], processWorldBooksWithTrigger: empty,
    buildPromptForRequestType: () => [{ role: 'user', content: 'story' }], generateCharacterListText: empty, generateOutfitEnableListText: empty,
    generateCommonCharacterListText: empty, getMergeOptionsForRequestType: noop, mergeAdjacentMessages: messages => messages,
    replaceAllPlaceholders: messages => ({ messages, replacedVariables: new Set() }), getEnabledCharacterImages: () => [],
    getEnabledOutfitImages: () => [], getCommonCharacterImages: () => [], updateCombinedPrompt: noop,
    applyWordReplacement: s => s.replaceAll('ALIAS', 'regex'), setTimeout: callback => callback(),
    imageReplyOwner: () => ({id:0,message,isCurrent:()=>true}), retainImageDrafts, saveChatConditional: noop, refreshImageDraftPanels: noop,
    insertImagesIntoElement: (_el, images) => inserted.push(...images),
  };
  vm.createContext(box);
  vm.runInContext(['getImageTags','removeThinkingTags','removeThinkingTextOnly','inspectPromptImages','buildParseFailureToastInfo','processImageLikeRequest'].map(bundledFunction).join('\n'), box);
  await box.processImageLikeRequest({}, '', 'image_gen', '正文图片生成', async () => ({result: replies[calls++]}));
  return { calls, warnings, inserted, message };
}

test('all-invalid responses warn once after the configured retry, using only the parsed block counts', async () => {
  const bad = `<think>${xml('ignore', 'ignore')}</think>` + '<image> </image>'.repeat(5);
  const { calls, warnings, inserted } = await request([bad, bad], 1);
  assert.equal(calls, 2); assert.deepEqual(inserted, []); assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /5 段缺少定位原文，5 段缺少完整绘图提示词/);
});

test('mixed and all-draft replies retain every nonempty item without requesting the model again', async () => {
  const { calls, warnings, inserted, message } = await request(['<image>ALIAS：河边的树。\nimage###willow###</image><image><prompts>unplaced</prompts></image><image>残缺字段</image>'], 2);
  assert.equal(calls, 1); assert.deepEqual(inserted, [{regex:'河边的树。', tag:'image###willow###'}, {regex:'',tag:'image###unplaced###',placement:'bottom'}]);
  assert.equal(warnings.length, 0); assert.equal(message.extra.chatu8CloudImageDrafts[0][0].raw, '残缺字段');
  const onlyDrafts = await request(['<image>残缺字段</image>'], 2);
  assert.equal(onlyDrafts.calls, 1); assert.deepEqual(onlyDrafts.inserted, []);
  assert.equal(onlyDrafts.message.extra.chatu8CloudImageDrafts[0].length, 1);
});

test('drafts persist per swipe, retain edits on repeated replies and promote only user-confirmed text', () => {
  const story = '<think>ignore <content></content></think><content>'+'河岸'.repeat(64)+'</content><status>sun</status>';
  const message = {mes:story, swipes:[story,'other'],swipe_id:0}, tags = {startTag:'image###',endTag:'###'};
  retainImageDrafts(message,['<bad>','<bad>']); message.extra.chatu8CloudImageDrafts[0][0].text='edited';
  retainImageDrafts(message,['<bad>','<bad>']); message.swipe_id=1; retainImageDrafts(message,['另一条草稿']);
  const restored = JSON.parse(JSON.stringify(message)); restored.swipe_id=0;
  const rows = restored.extra.chatu8CloudImageDrafts[0]; assert.equal(rows.length,2); assert.equal(rows[0].text,'edited');
  assert.throws(()=>promoteImageDraft(restored,rows[0],'<script>x</script>',tags,true)); assert.equal(rows.length,2);
  promoteImageDraft(restored, rows[0], 'quiet lake', tags, true);
  assert.match(restored.mes,/image###quiet lake###<\/image>\s*<\/content><status>/);
  assert.equal(restored.swipes[0],restored.mes); assert.equal(restored.swipes[1],'other');
  assert.equal(restored.extra.chatu8CloudImageDrafts[1].length,1);
  promoteImageDraft(restored, rows[0], 'moon', tags, false);
  assert.deepEqual(restored.extra.images[0], [{regex:'',tag:'image###moon###',placement:'bottom'}]);
  assert.equal(imageFooterOffset('plain'),5);
});
