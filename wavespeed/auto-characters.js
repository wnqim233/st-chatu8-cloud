/* Persistent character instructions for image-prompt requests. AFPL; see LICENSE. */
const imageRequests = new Set(['image_gen', 'char_display', 'tag_modify']);

export function autoCharacterState(settings = {}) {
  const id = settings.characterEnablePresetId;
  const preset = settings.characterEnablePresets?.[id];
  const characters = [], seen = new Set();
  for (const entry of Array.isArray(preset?.characters) ? preset.characters : []) {
    const key = typeof entry === 'string' ? entry : entry?.characterPresetName;
    const character = settings.characterPresets?.[key];
    if (!character || seen.has(key)) continue;
    seen.add(key);
    const names = [...new Set([character.nameCN, character.nameEN].flatMap(value =>
      typeof value === 'string' ? value.split('|').map(name => name.trim()).filter(name => name && !/[$\r\n]/.test(name)) : []))];
    if (names.length) characters.push({ key, name: names[0], aliases: names.slice(1), token: `$${names[0]}-sfw-upperbody$` });
  }
  return { id, preset, enabled: preset?.autoPromptEnabled === true, characters };
}

export function autoCharacterInstruction(settings, requestType) {
  if (!imageRequests.has(requestType)) return '';
  const { enabled, characters } = autoCharacterState(settings);
  if (!enabled || !characters.length) return '';
  return [
    '【固定角色外貌 · 自动要求】',
    '生成或修改绘图提示词时，先按当前剧情确定画面中实际出场的人物。下表仅供身份匹配，不是出场名单：未出场的角色不要加入，无人场景不要加入人物，也不要把未明确身份的路人替换成表中角色。',
    '画面中确有下列角色时，在该角色自己的绘图提示词中原样使用对应标记引用固定外貌；不能只写姓名，也不要另编与预设冲突的五官、发型、年龄和体型。多人画面分别放在各自角色段落，避免串脸。',
    '服装、表情、动作、视线和环境继续按当前剧情描写。不要因引用固定外貌改变剧情或增加人物。',
    '表中标记是上半身示例：全身构图可用 $角色名-sfw-upperbody-sfw-lowerbody$；背影或已有 JSON 角色格式时，可沿用 ${"name":"角色名","angle":"from behind","upperBody":"sfw","lowerBody":"hidden"}$，按画面可见部位填写，正面 angle 用空字符串。不要输出看不见部位的外貌。',
    '保留既有回复结构、image 标签、角色分段和工具调用要求；只在绘图提示词内容中使用标记，不要把本说明或下表输出为图片文字。',
    ...characters.map(({ name, aliases, token }) => JSON.stringify({ 角色: name, 别名: aliases, 外貌标记: token }))
  ].join('\n');
}

export function withAutoCharacterPrompt(messages, settings, requestType) {
  const instruction = autoCharacterInstruction(settings, requestType);
  if (!instruction || !Array.isArray(messages) || !messages.length) return messages;
  // Add only to the outgoing copy. Saved presets, history and retries stay clean.
  return [...messages, { role: 'user', content: instruction }];
}

export function createAutoCharacterControls({ settings, save, prepare, notify = () => {}, document: doc = globalThis.document }) {
  const bound = new WeakSet();
  let busy = false;
  function refresh() {
    const state = autoCharacterState(settings());
    for (const root of doc.querySelectorAll('[data-auto-characters]')) {
      const button = root.querySelector('button');
      const status = root.querySelector('[role="status"]');
      if (!button || !status) continue;
      button.disabled = busy;
      button.setAttribute('aria-pressed', String(state.enabled));
      button.textContent = state.enabled ? '固定角色已启动 · 点击关闭' : '启动固定角色';
      const names = state.characters.map(character => character.name).join('、');
      status.textContent = !state.preset ? '请先在「角色启用管理」选择一个角色列表。'
        : !names ? '请在「角色启用管理」把已导入的角色加入列表，再点击启动。'
        : `${state.id} · ${names}。${state.enabled ? '以后生成提示词会自动引用出场角色的固定外貌。' : '启动后自动补充外貌要求，并记住开关状态。'}`;
      if (bound.has(root)) continue;
      bound.add(root);
      button.addEventListener('click', async () => {
        if (busy) return;
        busy = true; refresh();
        let changedPreset, previous;
        try {
          const turnOn = !autoCharacterState(settings()).enabled;
          if (turnOn) await prepare?.();
          const current = autoCharacterState(settings());
          if (!current.preset || (turnOn && !current.characters.length)) {
            notify('请先在「角色启用管理」把已导入的角色加入列表，再启动固定角色。', true);
            return;
          }
          changedPreset = current.preset; previous = changedPreset.autoPromptEnabled;
          changedPreset.autoPromptEnabled = turnOn;
          await save();
          notify(turnOn ? '固定角色已启动，以后正常生成提示词即可。' : '固定角色已关闭。');
        } catch (error) {
          if (changedPreset) {
            if (previous === undefined) delete changedPreset.autoPromptEnabled;
            else changedPreset.autoPromptEnabled = previous;
          }
          notify(`固定角色设置未保存：${error.message || error}`, true);
        } finally { busy = false; refresh(); }
      });
    }
  }
  return { refresh };
}
