/* Added by Codex for the workspace owner, 2026-11-02. Aladdin Free Public License; see ../LICENSE. */
// Find the end of the story, before its closing tag / status panels, when present.
export function imageFooterOffset(text, root, nodes) {
  const content = nodes && root?.querySelector?.('content');
  if (content) {
    for (let i = nodes.length - 1; i >= 0; i--) if (content.contains(nodes[i].node)) return nodes[i].end;
  }
  const structure = text.replace(/<!--[^]*?-->|<(think|thinking|thought)\b[^>]*>[^]*?<\/\1\s*>/gi, match => ' '.repeat(match.length));
  const open = /<content\b[^>]*>/i.exec(structure);
  if (open) {
    const start = open.index + open[0].length;
    const end = structure.slice(start).search(/<\/content\s*>/i);
    if (end >= 0) return start + end;
  }
  return text.length;
}

// Inserting repeatedly at the same text offset reverses the resulting order.
// Insert footer items first at a tie, so anchored items remain nearest the sentence.
export function orderImageInsertions(rows, position) {
  return rows.reverse().sort((a, b) => b[position] - a[position] || Number(b.placement === 'bottom') - Number(a.placement === 'bottom'));
}

const key = 'chatu8CloudImageDrafts';
const swipe = message => message.swipe_id ?? 0;
const draftsFor = message => message?.extra?.[key]?.[swipe(message)] || [];

export function retainImageDrafts(message, rawBlocks) {
  const bySwipe = ((message.extra ??= {})[key] ??= {});
  const entries = (bySwipe[swipe(message)] ??= []);
  // Preserve the original and any manual edits. Reprocessing the same reply is idempotent.
  const counts = new Map();
  for (const entry of entries) counts.set(entry.raw, (counts.get(entry.raw) || 0) + 1);
  for (const raw of rawBlocks) {
    const count = counts.get(raw) || 0;
    if (count) counts.set(raw, count - 1);
    else entries.push({raw, text:raw});
  }
}

export function promoteImageDraft(message, draft, text, { startTag, endTag }, writeOriginal) {
  const clean = text.trim();
  if (!clean || /[<>]/.test(clean.replace(/<(?:lora|lyco):[^<>]+>/gi, '')) || clean.includes(startTag) || clean.includes(endTag)) {
    throw new Error('请在框内只保留绘图描述或标签，再加入楼底。');
  }
  const list = draftsFor(message), index = list.indexOf(draft);
  if (index < 0) throw new Error('这条草稿已不在当前回复中。');
  const tag = `${startTag}${clean}${endTag}`;
  if (writeOriginal && message.mes?.length >= 100) {
    const marker = `<image>${tag}</image>`;
    if (!message.mes.includes(marker)) {
      const end = imageFooterOffset(message.mes);
      message.mes = message.mes.slice(0, end) + '\n\n' + marker + '\n' + message.mes.slice(end);
      if (Array.isArray(message.swipes)) message.swipes[swipe(message)] = message.mes;
    }
  } else {
    const rows = ((message.extra.images ??= {})[swipe(message)] ??= []);
    if (!rows.some(row => row.tag === tag)) rows.push({regex:'', tag, placement:'bottom'});
  }
  list.splice(index, 1);
}

// Keep editable text outside .mes_text: neither the LLM context collector nor the
// automatic image-button scanner should mistake a damaged payload for another request.
export function showImageDrafts(mesText, message, actions) {
  let panel = mesText?.nextElementSibling;
  if (!panel?.classList.contains('chatu8-cloud-image-drafts')) panel = null;
  const entries = draftsFor(message);
  if (!entries.length) { panel?.remove(); return; }
  if (panel?.draftEntries === entries && panel.childElementCount === entries.length) return;
  const doc = mesText.ownerDocument;
  if (!panel) { panel = doc.createElement('div'); panel.className = 'chatu8-cloud-image-drafts'; mesText.after(panel); }
  panel.replaceChildren(); panel.draftEntries = entries;
  entries.forEach((entry, index) => {
    const details = doc.createElement('details'), title = doc.createElement('summary');
    title.textContent = `待补全的绘图段落 ${index + 1} · 展开编辑`;
    const input = doc.createElement('textarea'); input.value = entry.text; input.rows = 3;
    input.setAttribute('aria-label', `绘图草稿 ${index + 1}`);
    const status = doc.createElement('small'); status.setAttribute('role','status');
    const button = (label, callback) => {
      const el = doc.createElement('button'); el.type = 'button'; el.textContent = label;
      el.addEventListener('click', async () => {
        if (!actions.isCurrent() || !draftsFor(message).includes(entry)) return;
        el.disabled = true;
        try { await callback(); } catch (error) { status.textContent = error.message; }
        finally { el.disabled = false; }
      });
      return el;
    };
    const original = doc.createElement('details'), caption = doc.createElement('summary'), source = doc.createElement('pre');
    caption.textContent = '查看原始内容'; source.textContent = entry.raw; original.append(caption, source);
    details.append(title, original, input, button('保存修改', async () => { entry.text = input.value; await actions.save(); status.textContent = '已保存'; }),
      button('转为楼底绘图标签', () => actions.promote(entry, input.value)), status);
    panel.append(details);
  });
}
