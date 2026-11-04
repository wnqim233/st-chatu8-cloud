import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fn } from './llm-compat-fixture.mjs';
import { parseImageReply } from '../shared/image-reply.js';
import { createWaveSpeedAdapter } from '../wavespeed/adapter.js';
import { DEFAULT_CONFIG } from '../shared/config.js';
import { providerConfig } from '../wavespeed/client.js';
import { workflowBody } from '../shared/civitai.js';
import vm from 'node:vm';

const image = prompt => `<image><regex>窗边。</regex><prompts>${prompt}</prompts></image>`;
const plain = value => JSON.parse(JSON.stringify(value));

test('Kunlun guide resolves live variables and comments, preserves reference images and does not mutate its input', () => {
  const { box } = fixture();
  const request = { model: 'test-model', temperature: 0.6, messages: [
    { role: 'system', content: '{{// author note }} Character: {{getvar::appearance}}. Weather: {{getworldvar::weather}}.' },
    { role: 'system', content: '【ToolCall引导】工具说明\nDescribe {{getvar::character.eyes}}\n【ToolCall引导】字段说明\nReturn image XML' },
    { role: 'user', content: [{ type: 'text', text: '【ToolCall引导】[User Action]: use %TOOL_NAME%' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,ZmFrZQ==' } }] },
  ] };
  const snapshot = structuredClone(request);
  const result = box.transformToolCallRequest(request);
  assert.equal(result.isToolCallEnabled, true);
  assert.match(result.toolName, /^agw_emit_/);
  const body = result.transformedBody;
  const tool = body.tools.at(-1).function;
  assert.equal(body.model, 'test-model'); assert.equal(body.temperature, 0.6);
  assert.deepEqual(plain(tool.parameters.required), ['display_stream']);
  assert.match(tool.description, /blue eyes/); assert.match(tool.description, /silver hair/); assert.match(tool.description, /rain/);
  assert.doesNotMatch(JSON.stringify(body), /author note|%TOOL_NAME%|\{\{getvar/);
  const pictures = body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []);
  assert.equal(pictures.length, 2, 'reference and bundled terminal image are both present');
  assert.equal(pictures[0].image_url.url, request.messages[2].content[1].image_url.url);
  assert.match(pictures[1].image_url.url, /^data:image\/png;base64,/);
  assert.deepEqual(request, snapshot);
});

test('ordinary presets and legacy custom tools retain their settings without activating Kunlun', () => {
  const { box, settings } = fixture();
  const request = { model: 'old-model', messages: [{ role: 'user', content: 'draw a landscape' }] };
  assert.equal(box.transformToolCallRequest(request).isToolCallEnabled, false);
  settings.tool_call_config = { enabled: true, nameMode: 'fixed', fixedName: 'legacy_output', desc: 'describe {{getvar::appearance}}', fields: [{ name: 'content', description: '{{getglobalvar::lighting}}', required: true }] };
  const old = box.transformToolCallRequest(request);
  assert.equal(old.toolName, 'legacy_output');
  assert.deepEqual(plain(old.transformedBody.messages), request.messages);
  assert.equal(old.transformedBody.tools[0].function.description, 'describe silver hair');
  assert.equal(old.transformedBody.tools[0].function.parameters.properties.content.description, 'soft light');
  assert.deepEqual(plain(old.transformedBody.tools[0].function.parameters.required), ['content']);
});

test('new and old variable syntax support nested values, zeroes, set/get and bounded cycles', () => {
  const { box, ctx } = fixture();
  assert.equal(box.processStringVariables('{{getvar::nested}} / {@getvar::character.eyes@} / {{getglobalvar::lighting}} / {{getworldvar::zero}}'), 'silver hair / blue eyes / soft light / 0');
  assert.equal(box.processStringVariables('{{setvar::outfit::blue coat}}{{getvar::outfit}}'), 'blue coat');
  assert.equal(ctx.chatMetadata.variables.outfit, 'blue coat');
  assert.equal(box.processStringVariables('{@setglobalvar::season::winter@}{{getglobalvar::season}}'), 'winter');
  ctx.chatMetadata.variables.loop = '{{getvar::loop}}';
  assert.equal(box.processStringVariables('{{getvar::loop}}'), '{{getvar::loop}}');
});

test('preset comments are removed before variable side effects and guide roles are not merged', () => {
  const settings = { llm_request_type_configs: { image_gen: { context_profile: 'fixture' } }, test_context_profiles: { fixture: { entries: [
    { enabled: true, role: 'system', content: '//* author block\nline two\n*//\n{{// explanation }}Use {{getvar::appearance}}' },
    { enabled: true, role: 'user', content: '{{// {{setvar::bad::value}} }}' },
    { enabled: false, role: 'user', content: 'disabled' },
    { enabled: true, role: 'user', content: 'https://example.test/path // normal slash text' },
  ] } } };
  const { box, ctx } = fixture(settings);
  const messages = box.buildPromptForRequestType('image_gen');
  assert.match(messages[0].content, /Use silver hair/);
  assert.doesNotMatch(JSON.stringify(messages), /author block|line two|explanation|disabled/);
  assert.equal(ctx.chatMetadata.variables.bad, undefined);
  assert.match(JSON.stringify(messages), /https:\/\/example.test\/path/);
  const guides = [{ role: 'system', content: [{ type: 'text', text: '【ToolCall引导】one' }] }, { role: 'system', content: '【ToolCall引导】two' }];
  const merged = box.mergeAdjacentMessages(guides, { mergeSystemUser: true });
  assert.equal(merged.length, 2); assert.equal(merged[0].role, 'system');
});

test('display_stream survives accompanying thought text and legacy content remains supported', () => {
  const { box } = fixture();
  const payload = image('silver hair, rain');
  for (const name of ['agw_emit_abc', 'dispatch_stream_payload_new']) {
    const result = box.normalizeNonStreamingToolCall({ choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify({ thought: 'analysis only', display_stream: payload }) } }] } }] }, 'agw_emit_requested');
    assert.equal(parseImageReply(result.content).images[0].tag, 'image###silver hair, rain###');
    assert.ok(result.matched);
  }
  assert.equal(box.extractToolCallArguments(JSON.stringify({ content: 'legacy reply' })), 'legacy reply');
  assert.equal(box.extractToolCallArguments('{"display_stream":"partial prompt'), 'partial prompt');
});

test('streamed Kunlun output decodes one character at a time and keeps unrelated tool calls separate', () => {
  const { box } = fixture();
  const parser = new box.StreamToolCallParser('agw_emit_test', [{ name: 'display_stream', wrapTag: '' }]);
  const payload = image('银发, "rain", path\\name');
  const json = JSON.stringify({ display_stream: payload }).replace('银', '\\u94f6');
  let text = parser.processDeltaToolCalls([{ index: 1, function: { name: 'unrelated_lookup', arguments: '{"content":"wrong image"}' } }, { index: 0, function: { name: 'agw_emit_test', arguments: '' } }]).deltaContent;
  for (const character of json) text += parser.processDeltaToolCalls([{ index: 0, function: { arguments: character } }]).deltaContent;
  assert.equal(text, payload); assert.equal(parser.getFinalFallback(), payload);
  assert.doesNotMatch(text, /wrong image/);
  parser.reset('agw_emit_again', [{ name: 'display_stream' }]);
  assert.equal(parser.processDeltaToolCalls([{ index: 0, function: { name: 'dispatch_stream_payload', arguments: JSON.stringify({ display_stream: 'next' }) } }]).deltaContent, 'next');
  assert.equal(parser.getFinalFallback(), 'next');
});

test('new reasoning and terminal examples cannot become images, including incomplete streams', () => {
  const { box } = fixture();
  const good = image('real landscape'), bad = image('wrong example');
  for (const tag of ['pipeline_trace', 'assistant_trace', 'video_asset_think', 'latent_analysis', 'motion_trajectory', 'thinking']) {
    const text = `<${tag}>${bad}</${tag}>${good}`;
    assert.equal(parseImageReply(text).images.length, 1, tag);
    assert.equal(parseImageReply(text).images[0].tag, 'image###real landscape###');
    assert.equal(box.stripThinkingForPregen(`<${tag}>${bad}`), '', tag);
    assert.equal(box.stripThinkingForPregen(`<${tag.slice(0, 5)}`), '', tag);
    assert.equal(box.stripThinkingForPregen(text), good, tag);
  }
  const terminal = '```bash\n' + bad + '\n```\n' + good;
  assert.equal(parseImageReply(terminal).images.length, 1);
  assert.equal(box.stripThinkingForPregen(terminal).trim(), good);
  assert.equal(box.removeThinkBlocks(terminal), good);
  assert.equal(box.parseThinkingContent(terminal).cleanedText, good);
  for (const fence of ['```', '```xml', '```json']) {
    const reply = fence + '\n' + good + '\n```';
    assert.equal(parseImageReply(reply).images.length, 1);
    assert.equal(box.parseThinkingContent(reply).cleanedText, reply);
  }
});

test('Kunlun image output still reaches the Civitai prompt pipeline with existing model and payment parameters', async () => {
  const { box } = fixture();
  const reply = box.extractToolCallArguments(JSON.stringify({ display_stream: image('{{getvar::appearance}}, portrait') }));
  const expanded = box.processStringVariables(reply);
  const tag = parseImageReply(expanded).images[0].tag.slice('image###'.length, -3);
  const config = providerConfig({ ...DEFAULT_CONFIG, civitaiModel: 'urn:air:krea2:diffusionmodel:civitai:100@200+300', fixedPrompt: 'illustration', fixedPromptEnd: 'soft light' }, 'civitai');
  const adapter = createWaveSpeedAdapter({ replacePrompt: async text => ({ modifiedPrompt: text, insertions: {} }), composePrompt: async (a, b, c) => [a, b, c].filter(Boolean).join(', ') });
  const prepared = await adapter.prepare({ prompt: tag }, config);
  assert.equal(prepared.prompt, 'illustration, silver hair, portrait, soft light');
  const request = workflowBody({ prompt: prepared.prompt, params: prepared.params, model: config.imageModel, civitaiCurrency: 'yellow' });
  assert.equal(request.steps[0].input.prompt, prepared.prompt);
  assert.equal(request.steps[0].input.diffusionModel, config.imageModel);
  assert.deepEqual(request.tips, { creators: 0, civitai: 0 });
});

test('the actual LLM service sends the Kunlun request and returns streamed/non-streamed image content through the existing event', async () => {
  for (const stream of [false, true]) for (const guide of [false, true]) for (const toolMode of guide && stream ? ['renamed', 'matched'] : ['normal']) {
    const { box } = fixture();
    const events = [], sent = [], states = [];
    let loading = 0;
    Object.assign(box, {
      AbortController, TextDecoder, setTimeout, clearTimeout, activeRequests: new Map(), llmTaskControllers: new Map(),
      REQUEST_TYPE_NAMES: { image_gen: 'image' }, TaskType: { LLM: 'llm' }, TaskStatus: { RUNNING: 'running' },
      generateRequestKey: () => 'fixture-request', getEffectiveConfigForRequestType: () => ({ api_url: 'https://fixture.invalid/v1', api_key: 'fake-not-real', model: 'fixture', stream, bypass_proxy: true, send_images: false }),
      taskQueue: { addTask: () => 'task', updateStatus() {}, completeTask: (_id, success) => states.push(success) },
      acquireFabLoading: () => loading++, releaseFabLoading: () => loading--,
      formatPromptForDisplay: () => '', countImageParts: () => 0, addLog() {},
      parseCustomHeaders: () => ({}), isEmptyResponse: value => !value?.trim(), shouldApplyAiReplacement: () => false,
      isNonRetryableError: () => false, shouldRetryError: () => false,
      toastr: { warning() {}, error() {} }, eventSource6: { emit: (...event) => events.push(event) },
      createThrottledUIUpdater: () => ({ update() {}, flush() {} }),
      fetch: async (url, options) => {
        assert.equal(url, 'https://fixture.invalid/v1/chat/completions');
        const body = JSON.parse(options.body); sent.push(body);
        const payload = image('actual landscape');
        if (!stream) return new Response(JSON.stringify({ choices: [{ message: guide
          ? { tool_calls: [{ function: { name: body.tools[0].function.name, arguments: JSON.stringify({ thought: 'analysis only', display_stream: payload }) } }] }
          : { reasoning_content: image('reasoning example'), content: payload } }] }));
        const argumentsText = JSON.stringify({ thought: 'analysis only', display_stream: payload });
        const chunks = guide
          ? [{ reasoning_content: image('reasoning example') }, { tool_calls: [{ index: 0, function: { name: toolMode === 'renamed' ? 'provider_renamed_single_tool' : body.tools[0].function.name, arguments: '' } }] },
            ...[...argumentsText].map(char => ({ tool_calls: [{ index: 0, function: { arguments: char } }] }))]
          : [{ reasoning_content: image('reasoning example') }, { content: payload.slice(0, 20) }, { reasoning_content: image('second reasoning example') }, { content: payload.slice(20) }];
        const text = chunks.map(delta => 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
        return new Response(text);
      },
    });
    vm.runInContext(fn('stripImagesFromMessages') + '\n' + fn('executeTypedLLMRequest'), box);
    const prompt = [{ role: 'user', content: guide ? '【ToolCall引导】工具说明\nRender {{getvar::appearance}}' : 'Render {{getvar::appearance}}' }];
    await box.executeTypedLLMRequest({ id: 'fixture-image-123', prompt }, 'image_gen', 'st_chatu8_cloud_fixture_response');
    assert.equal(sent.length, 1); assert.equal(events.length, 1); assert.equal(events[0][0], 'st_chatu8_cloud_fixture_response');
    assert.equal(events[0][1].success, true, JSON.stringify(events));
    assert.deepEqual(parseImageReply(events[0][1].result).images.map(item => item.tag), ['image###actual landscape###']);
    assert.deepEqual(states, [true]); assert.equal(loading, 0); assert.equal(box.activeRequests.size, 0);
    assert.equal(!!sent[0].tools, guide);
    assert.doesNotMatch(JSON.stringify(sent[0]), /\{\{getvar/);
  }
});
