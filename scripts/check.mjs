import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const upstream = JSON.parse(await fs.readFile('docs/upstream-sha256.json', 'utf8'));
const expected = new Set(['index.js', 'manifest.json', 'settings.html', 'style.css', 'html/settings/main.html', 'README.md']);
const changed = [];
for (const [file, hash] of Object.entries(upstream.files)) {
  const content = await fs.readFile(file);
  if (createHash('sha256').update(content).digest('hex') !== hash) changed.push(file);
}
if (JSON.stringify([...changed].sort()) !== JSON.stringify([...expected].sort())) throw new Error(`Unexpected upstream modifications: ${changed.join(', ')}`);
const js = ['index.js'];
for (const dir of ['server', 'shared', 'wavespeed', 'scripts']) for (const file of await fs.readdir(dir)) if (/\.(mjs|js)$/.test(file)) js.push(path.join(dir, file));
for (const file of js) execFileSync(process.execPath, ['--check', file]);
const main = await fs.readFile('index.js', 'utf8');
const modules = JSON.parse(await fs.readFile('docs/reused-modules-sha256.json', 'utf8'));
const backports = JSON.parse(await fs.readFile('docs/backported-modules-sha256.json', 'utf8'));
const cloudUI = JSON.parse(await fs.readFile('docs/cloud-ui-modules-sha256.json', 'utf8'));
const replyFixes = JSON.parse(await fs.readFile('docs/image-reply-modules-sha256.json', 'utf8'));
const promptMenu = JSON.parse(await fs.readFile('docs/prompt-menu-modules-sha256.json', 'utf8'));
const llmCompat = JSON.parse(await fs.readFile('docs/llm-compat-modules-sha256.json', 'utf8'));
const kreaFix = JSON.parse(await fs.readFile('docs/krea2-fix-sha256.json', 'utf8'));
const characterFix = JSON.parse(await fs.readFile('docs/character-presets-sha256.json', 'utf8'));
const baseModules = { ...modules, ...Object.fromEntries(Object.entries(backports.modules).map(([name, audit]) => [name, audit.sha256])) };
const cloud13Modules = { ...baseModules, ...Object.fromEntries(Object.entries(cloudUI.modules).map(([name, audit]) => [name, audit.sha256])) };
const cloud14Modules = { ...cloud13Modules, ...Object.fromEntries(Object.entries(replyFixes.modules).map(([name, audit]) => [name, audit.sha256])) };
const cloud16Modules = { ...cloud14Modules, ...Object.fromEntries(Object.entries(promptMenu.modules).map(([name, audit]) => [name, audit.sha256])) };
const cloud18Modules = { ...cloud16Modules, ...Object.fromEntries(Object.entries(llmCompat.modules).map(([name, audit]) => [name, audit.sha256])) };
const expectedModules = { ...cloud18Modules, ...Object.fromEntries(Object.entries(characterFix.modules).map(([name, audit]) => [name, audit.sha256])) };
for (const [file, hash] of Object.entries(llmCompat.preservedFiles)) {
  const actual = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const update = kreaFix.files[file];
  if (update && update.beforeSha256 !== hash) throw new Error(`Krea fix baseline mismatch: ${file}`);
  const characterUpdate = characterFix.files[file];
  if (characterUpdate && characterUpdate.beforeSha256 !== (update?.sha256 ?? hash)) throw new Error(`Character fix baseline mismatch: ${file}`);
  if (actual !== (characterUpdate?.sha256 ?? update?.sha256 ?? hash)) throw new Error(`Preserved or documented cloud file changed: ${file}`);
}
for (const [file, audit] of Object.entries(kreaFix.files)) {
  const actual = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const update = characterFix.files[file];
  if (update && update.beforeSha256 !== audit.sha256) throw new Error(`Character fix baseline mismatch: ${file}`);
  if (actual !== (update?.sha256 ?? audit.sha256)) throw new Error(`Krea fix fingerprint mismatch: ${file}`);
}
for (const [file, audit] of Object.entries(characterFix.files)) {
  const actual = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  if (actual !== audit.sha256) throw new Error(`Character fix fingerprint mismatch: ${file}`);
}
for (const [name, expectedHash] of Object.entries(expectedModules)) {
  const marker = `// ${name}\n`;
  const start = main.lastIndexOf(marker);
  if (start < 0) throw new Error(`Missing original module: ${name}`);
  const next = /^\/\/ [a-zA-Z][^\n]*\.(?:js|ts)\s*$/m.exec(main.slice(start + marker.length));
  const end = next ? start + marker.length + next.index : main.length;
  let moduleSource = main.slice(start, end);
  // Only the persistent chat metadata key changes in this upstream module.
  if (name === 'utils/chatDataUtils.js') moduleSource = moduleSource.replaceAll('["st-chatu8-cloud"]', '["st-chatu8"]');
  const actual = createHash('sha256').update(moduleSource).digest('hex');
  if (actual !== expectedHash) throw new Error(`Module differs from its documented original/backport fingerprint: ${name}`);
  if (modules[name] && backports.modules[name] && backports.modules[name].beforeSha256 !== modules[name]) throw new Error(`Backport baseline mismatch: ${name}`);
  if (baseModules[name] && cloudUI.modules[name] && cloudUI.modules[name].beforeSha256 !== baseModules[name]) throw new Error(`Cloud UI baseline mismatch: ${name}`);
  if (cloud13Modules[name] && replyFixes.modules[name] && replyFixes.modules[name].beforeSha256 !== cloud13Modules[name]) throw new Error(`Image reply baseline mismatch: ${name}`);
  if (cloud14Modules[name] && promptMenu.modules[name] && promptMenu.modules[name].beforeSha256 !== cloud14Modules[name]) throw new Error(`Prompt menu baseline mismatch: ${name}`);
  if (cloud16Modules[name] && llmCompat.modules[name] && llmCompat.modules[name].beforeSha256 !== cloud16Modules[name]) throw new Error(`LLM compatibility baseline mismatch: ${name}`);
  if (cloud18Modules[name] && characterFix.modules[name] && characterFix.modules[name].beforeSha256 !== cloud18Modules[name]) throw new Error(`Character module baseline mismatch: ${name}`);
}
for (const hook of ['getWaveSpeedAdapter().mount();', 'getWaveSpeedAdapter().updateMode();', '"wavespeed": { widthKey:', 'var tabIds = ["wavespeed",']) if (!main.includes(hook)) throw new Error(`Missing hook: ${hook}`);
const html = await fs.readFile('html/settings/wavespeed.html', 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
if (new Set(ids).size !== ids.length) throw new Error('Duplicate WaveSpeed UI IDs');
if (!main.includes('expandCharacters: prompt => expandCloudCharacters(prompt, processCharacterPrompt, window)')) throw new Error('Missing character preset integration hook');
console.log(`PASS: ${Object.keys(characterFix.files).length} character integration file fingerprints; ${Object.keys(characterFix.modules).length} character module fingerprint; production preset hook checked.`);
console.log(`PASS: ${js.length} JS syntax checks; ${Object.keys(upstream.files).length - changed.length} upstream files byte-identical; exactly ${changed.length} declared upstream files modified; ${Object.keys(modules).filter(name => name !== 'utils/chatDataUtils.js' && !backports.modules[name] && !cloudUI.modules[name] && !replyFixes.modules[name] && !promptMenu.modules[name] && !llmCompat.modules[name]).length} reused modules byte-identical; ${Object.keys(backports.modules).length} documented backport fingerprints; ${Object.keys(cloudUI.modules).length} cloud UI fingerprints; ${Object.keys(replyFixes.modules).length} image reply fingerprints; ${Object.keys(promptMenu.modules).length} prompt menu fingerprint; ${Object.keys(llmCompat.modules).length} LLM compatibility fingerprints; ${Object.keys(llmCompat.preservedFiles).filter(file => !kreaFix.files[file]).length} Civitai/prompt-menu files preserved; ${Object.keys(kreaFix.files).length} Krea fix fingerprints; chatDataUtils storage-key normalization; hooks and HTML IDs checked.`);
