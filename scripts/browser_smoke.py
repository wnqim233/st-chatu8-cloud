"""Run the local mock integration page in Qt WebEngine. No real API calls."""
import json
import os
import sys
from pathlib import Path

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
os.environ.setdefault('QTWEBENGINE_CHROMIUM_FLAGS', '--disable-gpu --disable-dev-shm-usage')
from PySide6.QtCore import QTimer, QUrl
from PySide6.QtWidgets import QApplication
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile
from PySide6.QtWebEngineWidgets import QWebEngineView

output = Path(__file__).resolve().parents[1] / 'test-results'
output.mkdir(exist_ok=True)
app = QApplication([])
errors = []
results = []
done = False
reload_stage = False

class Page(QWebEnginePage):
    def javaScriptConsoleMessage(self, level, message, line, source):
        if level == QWebEnginePage.JavaScriptConsoleMessageLevel.ErrorMessageLevel:
            errors.append({'message': message, 'line': line, 'source': source})

profile = QWebEngineProfile(app)
view = QWebEngineView()
page = Page(profile, view)
view.setPage(page)
view.resize(1100, 950)
view.show()

def run(script, callback=lambda _value: None):
    page.runJavaScript(script, callback)

def wait_for(expression, callback, remaining=120):
    def checked(value):
        if value:
            callback()
        elif remaining > 0:
            QTimer.singleShot(150, lambda: wait_for(expression, callback, remaining - 1))
        else:
            errors.append({'message': 'Timed out: ' + expression})
            finish()
    run(expression, checked)

def start():
    wait_for("window.fixture?.ready && document.getElementById('ws-status').textContent.includes('已就绪')", save)

def save():
    run("document.getElementById('ws-key').value='fixture-key-not-real';document.getElementById('ws-save').click();")
    wait_for("document.getElementById('ws-status').textContent.includes('已保存')", models)

def models():
    run("document.getElementById('ws-models').click();")
    wait_for("document.getElementById('ws-model-list').children.length===1", generate)

def generate():
    view.grab().save(str(output / 'wavespeed-desktop.png'))
    run("document.getElementById('fixture-generate').click();")
    wait_for("window.fixture.responses.length===1", inspect)

def inspect():
    run("JSON.stringify({success:fixture.responses[0].success,error:fixture.responses[0].error,cacheCount:fixture.cache.length,imageIsData:fixture.responses[0].imageData?.startsWith('data:image/'),taskCards:document.querySelectorAll('.ws-job').length,keyInputCleared:document.getElementById('ws-key').value==='',overflow:document.documentElement.scrollWidth>innerWidth})", inspected)

def inspected(value):
    record = json.loads(value)
    results.append(record)
    if not (record.get('success') and record['cacheCount'] == 1 and record['imageIsData'] and record['keyInputCleared'] and not record['overflow']):
        errors.append({'message': 'Desktop integration assertions failed', 'record': record})
    run("document.getElementById('ws-civitai-key').value='fixture-civitai-key-not-real';document.getElementById('ws-civitai-estimate').click();")
    wait_for("document.getElementById('ws-status').textContent.includes('预估 8 Buzz')", civitai_generate)

def civitai_generate():
    run("document.getElementById('ws-civitai-use').click();document.getElementById('ws-civitai-model').scrollIntoView();")
    QTimer.singleShot(250, civitai_capture)

def civitai_capture():
    view.grab().save(str(output / 'civitai-desktop.png'))
    run("document.getElementById('fixture-generate').click();")
    wait_for("window.fixture.responses.length===2", civitai_inspect)

def civitai_inspect():
    run("JSON.stringify({success:fixture.responses[1].success,cacheCount:fixture.cache.length,provider:fixture.cache[1]?.[2].genParams.backend,keyInputCleared:document.getElementById('ws-civitai-key').value==='',taskCards:document.querySelectorAll('.ws-job').length})", civitai_checked)

def civitai_checked(value):
    record = json.loads(value)
    results.append(record)
    if not (record.get('success') and record['cacheCount'] == 2 and record['provider'] == 'Civitai' and record['keyInputCleared'] and record['taskCards'] == 2):
        errors.append({'message': 'Civitai integration assertions failed', 'record': record})
    # Mobile view uses the same code and original style imports.
    view.resize(390, 844)
    run("document.getElementById('fixture-result').style.display='none';window.scrollTo(0,0)")
    QTimer.singleShot(500, mobile)

def mobile():
    view.grab().save(str(output / 'wavespeed-mobile.png'))
    run("JSON.stringify({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth})", mobile_checked)

def mobile_checked(value):
    global reload_stage
    result = json.loads(value)
    results.append(result)
    if result['overflow']:
        errors.append({'message': 'Mobile horizontal overflow', 'record': result})
    reload_stage = True
    view.reload()

def after_reload():
    wait_for("window.fixture?.ready && document.getElementById('ws-status').textContent.includes('已就绪')", reload_query)

def reload_query():
    run("document.getElementById('ws-jobs-refresh').click();")
    wait_for("document.querySelectorAll('.ws-job').length===2", reload_images)

def reload_images():
    run("fetch(document.querySelector('.ws-job img').src).then(r=>r.blob()).then(b=>fixture.reloadedImage=b.type==='image/png'&&b.size>0)")
    wait_for("fixture.reloadedImage===true", reload_inspect)

def reload_inspect():
    run("JSON.stringify({keysRetained:document.getElementById('ws-key').placeholder.includes('已保存')&&document.getElementById('ws-civitai-key').placeholder.includes('已保存'),imagesRecovered:fixture.reloadedImage,noProviderRequest:!fixture.requests.some(u=>u.startsWith('https://api.wavespeed.ai')||u.startsWith('https://orchestration.civitai.com')),noServerPlugin:!fixture.requests.some(u=>u.includes('/api/plugins/'))})", reload_checked)

def reload_checked(value):
    record = json.loads(value)
    results.append(record)
    if not all(record.values()):
        errors.append({'message': 'Reload persistence / no-plugin assertions failed', 'record': record})
    finish()

def finish():
    global done
    if done:
        return
    done = True
    result = {'fixture': 'Real browser adapter, IndexedDB and shared engine; static server has no API plugin; mocked providers and upstream callbacks', 'results': results, 'errors': errors, 'passed': not errors and len(results) == 4}
    (output / 'browser-smoke.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False))
    app.exit(0 if result['passed'] else 1)

page.loadFinished.connect(lambda ok: (after_reload() if reload_stage else start()) if ok else (errors.append({'message': 'Page load failed'}), finish()))
page.load(QUrl('http://127.0.0.1:8765/'))
QTimer.singleShot(60000, lambda: (errors.append({'message': 'Global test timeout'}), finish()))
sys.exit(app.exec())
