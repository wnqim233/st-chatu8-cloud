/* Generation-button prompt menu. Aladdin Free Public License; see ../LICENSE. */
let closeActiveMenu;

export function bindPromptCopyMenu(button, { getPrompt, copy, notify, generate }) {
  let timer;
  let held = false;
  let start;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  button.style.touchAction = 'manipulation';
  button.style.userSelect = 'none';
  button.style.webkitTouchCallout = 'none';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.title = '点击生成；长按复制提示词';

  const open = () => {
    closeActiveMenu?.();
    let doc = button.ownerDocument;
    let rect = button.getBoundingClientRect();
    // Chat buttons can live in a short iframe: put the menu in the top document.
    try {
      let win = doc.defaultView;
      let left = rect.left, bottom = rect.bottom;
      while (win !== win.parent) {
        const frame = win.frameElement;
        if (!frame) break;
        const box = frame.getBoundingClientRect();
        const scaleX = frame.offsetWidth ? box.width / frame.offsetWidth : 1;
        const scaleY = frame.offsetHeight ? box.height / frame.offsetHeight : 1;
        left = box.left + (frame.clientLeft + left) * scaleX;
        bottom = box.top + (frame.clientTop + bottom) * scaleY;
        win = win.parent;
      }
      doc = win.document;
      rect = { left, bottom };
    } catch { /* A cross-origin ancestor cannot host the menu. */ }
    const overlay = doc.createElement('div');
    overlay.className = 'st-chatu8-prompt-menu-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent;';
    const menu = doc.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '生成按钮菜单');
    menu.style.cssText = 'position:absolute;box-sizing:border-box;min-width:164px;max-width:calc(100% - 16px);padding:6px;border:1px solid #666;border-radius:10px;background:var(--st-chatu8-bg-primary,#292929);color:var(--st-chatu8-text-primary,#fff);box-shadow:0 6px 24px #0006;';
    const item = doc.createElement('button');
    item.type = 'button';
    item.textContent = '复制提示词';
    item.setAttribute('role', 'menuitem');
    item.disabled = true;
    item.style.cssText = 'display:block;width:100%;min-height:44px;padding:10px 18px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;';
    item.onmouseenter = () => { item.style.background = '#8883'; };
    item.onmouseleave = () => { item.style.background = 'transparent'; };
    menu.append(item); overlay.append(menu); doc.body.append(overlay);
    const place = () => {
      const width = doc.documentElement.clientWidth, height = doc.documentElement.clientHeight;
      menu.style.left = `${Math.max(8, Math.min(rect.left, width - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(rect.bottom + 6, height - menu.offsetHeight - 8))}px`;
    };
    place();
    button.setAttribute('aria-expanded', 'true');
    const close = () => {
      overlay.remove();
      doc.removeEventListener('keydown', onKey, true);
      doc.defaultView.removeEventListener('resize', close);
      button.setAttribute('aria-expanded', 'false');
      if (closeActiveMenu === close) closeActiveMenu = undefined;
      if (button.isConnected) button.focus({ preventScroll: true });
    };
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === 'Tab' && !menu.querySelector('textarea')) { event.preventDefault(); item.focus(); }
    };
    closeActiveMenu = close;
    overlay.addEventListener('pointerdown', event => { if (event.target === overlay) { event.preventDefault(); close(); } });
    overlay.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
    overlay.addEventListener('contextmenu', event => event.preventDefault());
    doc.addEventListener('keydown', onKey, true);
    doc.defaultView.addEventListener('resize', close);

    // Resolve before the copy click, so mobile clipboard access keeps its user gesture.
    Promise.resolve().then(getPrompt).then(result => {
      if (!overlay.isConnected) return;
      const text = result.text;
      if (!text?.trim()) { notify('这张图暂无可复制的提示词', true); close(); return; }
      item.disabled = false;
      item.focus({ preventScroll: true });
      item.onclick = async event => {
        event.preventDefault(); event.stopPropagation();
        if (await copy(doc, text)) {
          close();
          notify(result.fallback ? '已复制原始提示词；暂时无法读取完整生图提示词' : result.actual ? '已复制本次生图提示词' : '已复制当前提示词', !!result.fallback);
        } else {
          let field = menu.querySelector('textarea');
          if (!field) {
            field = doc.createElement('textarea'); field.readOnly = true;
            field.setAttribute('aria-label', '提示词（可手动复制）');
            field.style.cssText = 'box-sizing:border-box;width:280px;max-width:100%;height:150px;font-size:16px;';
            field.value = text; menu.append(field); place();
          }
          field.focus(); field.select(); field.setSelectionRange(0, text.length);
          notify('自动复制受限，已选中提示词，可使用系统复制', true);
        }
      };
    }).catch(() => { if (overlay.isConnected) { notify('读取提示词失败，请重试', true); close(); } });
  };

  button.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    cancel(); held = false; start = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => { held = true; cancel(); open(); }, 650);
  });
  button.addEventListener('pointermove', event => {
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel();
  });
  for (const name of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) button.addEventListener(name, cancel);
  button.addEventListener('contextmenu', event => {
    event.preventDefault(); event.stopPropagation(); cancel();
    if (button.getAttribute('aria-expanded') !== 'true') { held = true; open(); }
  });
  button.addEventListener('keydown', event => {
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault(); cancel(); held = true; open();
    } else if (event.key === 'Enter' || event.key === ' ') held = false;
  });
  button.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    if (!held) generate();
  });
}
