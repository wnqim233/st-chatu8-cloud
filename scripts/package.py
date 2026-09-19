"""Package the independent browser extension, plus complete development source."""
import hashlib
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1]
dist = root / 'dist'
dist.mkdir(exist_ok=True)
target = dist / 'st-chatu8-cloud-3.1.0-cloud8.zip'
excluded = {'.git', '.agents', '.codex', 'backups', 'dist', 'node_modules', 'test-results', '__pycache__'}
entries = []
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(root.rglob('*')):
        rel = file.relative_to(root)
        if not file.is_file() or any(part in excluded for part in rel.parts) or file.name == '.env':
            continue
        if rel.parts[0] in {'server', 'tests', 'scripts'}:
            continue
        name = Path('st-chatu8-cloud') / rel
        archive.write(file, str(name))
        entries.append(str(name))
    archive.write(root / 'INSTALL_WAVESPEED.md', '安装说明.md')
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
    for required in ['st-chatu8-cloud/manifest.json', 'st-chatu8-cloud/index.js', 'st-chatu8-cloud/html/settings/send_data.html', 'st-chatu8-cloud/wavespeed/browser.js', 'st-chatu8-cloud/shared/jobs.js', 'st-chatu8-cloud/LICENSE', '安装说明.md']:
        assert required in archive.namelist(), required
digest = hashlib.sha256(target.read_bytes()).hexdigest()
(dist / (target.name + '.sha256')).write_text(f'{digest}  {target.name}\n')
print(json.dumps({'archive': str(target), 'files': len(entries) + 1, 'bytes': target.stat().st_size, 'sha256': digest}, ensure_ascii=False, indent=2))

source = dist / 'st-chatu8-cloud-3.1.0-cloud8-source.zip'
with zipfile.ZipFile(source, 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(root.rglob('*')):
        rel = file.relative_to(root)
        if file.is_file() and not any(part in excluded for part in rel.parts) and file.name != '.env':
            archive.write(file, str(Path('st-chatu8-source') / rel))
with zipfile.ZipFile(source) as archive:
    assert archive.testzip() is None
    for required in ['server/civitai.mjs', 'server/index.mjs', 'tests/civitai.test.mjs', 'package.json', 'LICENSE']:
        assert 'st-chatu8-source/' + required in archive.namelist()
digest = hashlib.sha256(source.read_bytes()).hexdigest()
(dist / (source.name + '.sha256')).write_text(f'{digest}  {source.name}\n')
print(json.dumps({'source': str(source), 'bytes': source.stat().st_size, 'sha256': digest}, ensure_ascii=False, indent=2))
