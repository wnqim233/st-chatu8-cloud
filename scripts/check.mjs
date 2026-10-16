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
const expectedModules = { ...modules, ...Object.fromEntries(Object.entries(backports.modules).map(([name, audit]) => [name, audit.sha256])) };
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
}
for (const hook of ['getWaveSpeedAdapter().mount();', 'getWaveSpeedAdapter().updateMode();', '"wavespeed": { widthKey:', 'var tabIds = ["wavespeed",']) if (!main.includes(hook)) throw new Error(`Missing hook: ${hook}`);
const html = await fs.readFile('html/settings/wavespeed.html', 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
if (new Set(ids).size !== ids.length) throw new Error('Duplicate WaveSpeed UI IDs');
console.log(`PASS: ${js.length} JS syntax checks; ${Object.keys(upstream.files).length - changed.length} upstream files byte-identical; exactly ${changed.length} declared upstream files modified; ${Object.keys(modules).filter(name => name !== 'utils/chatDataUtils.js' && !backports.modules[name]).length} reused modules byte-identical; ${Object.keys(backports.modules).length} documented backport fingerprints; chatDataUtils storage-key normalization; hooks and HTML IDs checked.`);
