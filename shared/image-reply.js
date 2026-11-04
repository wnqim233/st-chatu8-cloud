/* Added by Codex for the workspace owner, 2026-11-02. Aladdin Free Public License; see ../LICENSE.
 * Parse complete image payloads independently, without guessing missing prompts or anchors.
 */
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const field = (text, name) => new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i').exec(text);
const value = (text, name) => field(text, name)?.[1].trim() || '';

function cleanReply(text) {
  return (typeof text === 'string' ? text : '')
    .replace(/<\\(images?|regex|prompts|scene_composition|character_\d+|prompt|centers|uc|size|title_styled|tag_think)\s*>/gi, '</$1>')
    .replace(/<!--[^]*?(?:-->|$)/g, '')
    .replace(/<(think|thinking|thought|assistant_trace|trace|pipeline_trace|video_asset_think|motion_trajectory|latent_analysis)\b[^>]*>[^]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/(^|\n)[ \t]*```(?:bash|sh|console|linux|terminal)[^\n]*\n[^]*?(?:\n[ \t]*```(?=\s*(?:\n|$))|$)/gi, '$1');
}

const displayFields = /<(tag_think|font|title_styled)\b[^>]*>[^]*?(?:<\/\1\s*>|$)/gi;

function sections(source, name) {
  // Preserve offsets while hiding displayed reasoning/titles (they can mention <image>).
  const structure = source.replace(displayFields, match => ' '.repeat(match.length));
  const boundaries = new RegExp(`<(/?)${name}(?:\\s[^<>]*?)?\\s*>`, 'gi');
  const blocks = [];
  let start = null;
  for (const mark of structure.matchAll(boundaries)) {
    const closed = mark[1] === '/';
    if (start !== null) blocks.push({ body: source.slice(start, mark.index), closed });
    start = closed ? null : mark.index + mark[0].length;
  }
  if (start !== null) blocks.push({ body: source.slice(start), closed: false });
  return blocks;
}

function collectBlocks(source) {
  const containers = sections(source, 'images');
  if (!containers.length) return sections(source, 'image');
  // When containers exist, their contents are authoritative. Ignore examples outside.
  return containers.flatMap(container => {
    const body = container.body.replace(/<\/?(?:table|tr|td)\b[^>]*>/gi, '\n');
    const explicit = sections(body, 'image');
    if (explicit.length) return explicit;
    // Old presets may omit the individual image wrappers inside <images>.
    const positions = [...body.matchAll(/^[ \t]*regex[ \t]*[:：]/gim)];
    if (!positions.length && body.trim()) return [{body, closed: container.closed}];
    return positions.map((position, i) => ({ body: body.slice(position.index, positions[i + 1]?.index ?? body.length), closed: false }));
  });
}

function xmlPrompt(body) {
  const prompts = field(body, 'prompts') || (!/<(?:prompts|character_\d+)\b/i.test(body) && field(body, 'prompt'));
  if (!prompts) return null;
  const inner = prompts[1];
  const scene = field(inner, 'scene_composition');
  const characters = [...inner.matchAll(/<character_(\d+)\b[^>]*>([^]*?)<\/character_\1\s*>/gi)];
  const size = value(body, 'size').replace(/，/g, ',').split(',').pop().trim();
  const withSize = content => size ? `${content.replace(/,\s*$/, '')}${content ? ',' : ''}${size}` : content;
  if (!scene && !characters.length) {
    if (/<\/?(?:scene_composition|character_\d+|prompt|centers|uc)\b/i.test(inner)) return null;
    return inner.trim() ? { content: withSize(inner.trim()), match: prompts } : null;
  }
  // Do not accept an unfinished character alongside an otherwise complete scene.
  const remaining = inner.replace(/<scene_composition\b[^>]*>[^]*?<\/scene_composition\s*>/gi, '')
    .replace(/<character_(\d+)\b[^>]*>[^]*?<\/character_\1\s*>/gi, '');
  if (/<\/?(?:scene_composition|character_\d+)\b/i.test(remaining)) return null;
  const parts = [];
  const sceneText = scene?.[1].trim() || '';
  if (sceneText || size) parts.push(`Scene Composition:${withSize(sceneText)};`);
  let hasPrompt = !!sceneText;
  for (const character of characters) {
    const prompt = value(character[2], 'prompt');
    if (!prompt) return null;
    hasPrompt = true;
    parts.push(`Character ${character[1]} Prompt:${prompt}|centers:${value(character[2], 'centers')};`);
    const uc = value(character[2], 'uc');
    if (uc) parts.push(`Character ${character[1]} UC:${uc};`);
  }
  return hasPrompt ? { content: parts.join('\n'), match: prompts } : null;
}

function readPrompt(body, startTag, endTag, closed) {
  const defaultStart = 'image[ \\t]*[#＃]{3}', defaultEnd = '[#＃]{3}';
  const markers = [[startTag === 'image###' ? defaultStart : escapeRegExp(startTag), endTag === '###' ? defaultEnd : escapeRegExp(endTag)]];
  if (startTag !== 'image###' || endTag !== '###') markers.push([defaultStart, defaultEnd]);
  const xml = xmlPrompt(body);
  if (xml) {
    for (const [start, end] of markers) {
      const wrapped = new RegExp(`^${start}([\\s\\S]*?)${end}$`, 'i').exec(xml.content);
      if (wrapped) return wrapped[1].trim() ? { ...xml, content: wrapped[1].trim() } : null;
    }
    return xml;
  }
  for (const [start, end] of markers) {
    const match = new RegExp(`${start}([\\s\\S]*?)${end}`, 'i').exec(body);
    if (match?.[1].trim()) return { content: match[1].trim(), match };
  }
  // The explicit </image> can close a legacy prompt with a missing final ###.
  // Never extend a truncated model reply or consume another markup field this way.
  if (closed && endTag === '###') {
    const match = /image[ \t]*###([^<>#]+)$/i.exec(body);
    if (match?.[1].trim()) return { content: match[1].trim(), match };
  }
  return null;
}

function readAnchor(body) {
  const metadata = body.replace(/<\/?imgthink\b[^>]*>/gi, '\n');
  const line = /^[ \t]*(?:\*\*)?regex[ \t]*(?:\*\*)?[ \t]*[:：][ \t]*(?:\*\*)?[ \t]*([^\r\n]*)/im.exec(metadata);
  return line?.[1].trim() || '';
}

function echoMetadata(body, startTag) {
  const title = value(body, 'title_styled');
  const font = /<font\b[^>]*>[^]*?<\/font\s*>/i.exec(body)?.[0] || '';
  const think = field(body, 'tag_think')?.[0] || '';
  // Downstream buttons scan this string for the first trigger. Do not echo metadata
  // that could become an extra button or take the actual prompt's place.
  return [title ? `<font color="steelblue">[${title}]</font>` : font, think]
    .filter(part => part && !part.includes(startTag) && !/<\/?images?\b/i.test(part));
}

export function parseImageReply(text, { startTag = 'image###', endTag = '###', tagthinkEcho = false } = {}) {
  const source = cleanReply(text);
  const blocks = collectBlocks(source);
  const report = { images: [], drafts: [], totalBlocks: blocks.length, footerCount: 0, missingAnchor: 0, missingPrompt: 0, incompleteBlocks: 0, empty: !source.trim() };
  for (const block of blocks) {
    // Tag_think is display metadata and may itself contain example marker strings.
    const body = block.body.replace(displayFields, '\n');
    const xmlAnchor = field(body, 'regex');
    const rest = xmlAnchor ? body.replace(xmlAnchor[0], '\n') : body;
    let prompt = readPrompt(rest, startTag, endTag, block.closed);
    const anchor = xmlAnchor ? xmlAnchor[1].trim() : readAnchor(prompt ? rest.replace(prompt.match[0], '\n') : rest);
    const footer = !anchor || !prompt;
    if (!anchor) report.missingAnchor++;
    if (!prompt && block.closed) {
      const plain = rest.replace(/<imgthink\b[^>]*>[^]*?<\/imgthink>/gi, '').replace(/^[ \t]*(?:\*\*)?regex[ \t]*(?:\*\*)?[ \t]*[:：].*$/gim, '').trim();
      const labeled = /^(?:prompts?|提示词|绘图提示词)\s*[:：]\s*([^]+)$/i.exec(plain);
      const bareList = /[,，]/.test(plain) && !/[\r\n{}\[\]`|]/.test(plain) && !/^\w+\s*[:：]/.test(plain);
      const candidate = (labeled ? labeled[1] : bareList ? plain : '').trim();
      if (candidate && !/[<>#＃]/.test(candidate) && !candidate.includes(startTag) && !candidate.includes(endTag)) prompt = { content: candidate };
    }
    if (!prompt) {
      report.missingPrompt++;
      if (!block.closed) report.incompleteBlocks++;
      if (block.body.trim()) report.drafts.push(block.body.trim());
      continue;
    }
    const content = prompt.content.replace(/，/g, ',').replace(/；/g, ';').replace(/：/g, ':').replace(/,\s*/g, ', ');
    const tag = `${startTag}${content}${endTag}`;
    if (footer) report.footerCount++;
    report.images.push({ regex: anchor, tag: tagthinkEcho ? [...echoMetadata(block.body, startTag), tag].join('\n') : tag, ...(footer ? { placement: 'bottom' } : {}) });
  }
  return report;
}

export function imageReplyFailureInfo(report) {
  const info = { level: 'warning', title: '图片提示词未能解析', message: '' };
  if (report.empty) info.message = 'LLM 没有返回有效内容，请检查接口响应后重试。';
  else if (!report.totalBlocks) info.message = '回复中没有可识别的图片段落。请检查 LLM 预设是否要求输出 <image> 图片标签。';
  else {
    const reasons = [];
    if (report.missingAnchor) reasons.push(`${report.missingAnchor} 段缺少定位原文`);
    if (report.missingPrompt) reasons.push(`${report.missingPrompt} 段缺少完整绘图提示词`);
    info.message = `检测到 ${report.totalBlocks} 段图片内容：${reasons.join('，')}。`;
    info.message += report.incompleteBlocks ? '回复可能被截断，请减少单次图片数或提高回复长度后重试。' : '请检查 LLM 预设；支持 regex: / image###...### 和 <regex> / <prompts> 两种格式。';
  }
  return info;
}
