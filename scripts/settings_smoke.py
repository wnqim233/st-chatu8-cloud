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
        if value is True:
            callback()
        elif remaining > 0:
            QTimer.singleShot(150, lambda: wait_for(expression, callback, remaining - 1))
        else:
            errors.append({'message': 'Timed out: ' + expression})
            finish()
    run(expression, checked)

def start():
    wait_for("Boolean(window.regression?.result)", inspect)
def inspect():
    run("JSON.stringify(regression.result)", inspected)
def inspected(value):
    result=json.loads(value)
    result['consoleErrors']=errors
    (output / 'settings-import.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps(result,ensure_ascii=False))
    QTimer.singleShot(400, lambda: capture(result))
def capture(result):
    view.grab().save(str(output / 'settings-import-desktop.png'))
    view.resize(390,844)
    QTimer.singleShot(400, lambda: mobile(result))
def mobile(result):
    view.grab().save(str(output / 'settings-import-mobile.png'))
    run("JSON.stringify({visible:regression.state().waveVisible,overflow:document.documentElement.scrollWidth>innerWidth})",lambda value:finish_mobile(result,value))
def finish_mobile(result,value):
    mobile=json.loads(value)
    result['mobile']=mobile
    result['passed']=result['passed'] and mobile['visible'] and not mobile['overflow'] and not errors
    (output / 'settings-import.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps(mobile))
    app.exit(0 if result['passed'] else 1)
def finish():
    print(errors)
    app.exit(1)
page.loadFinished.connect(lambda ok: start() if ok else finish())
page.load(QUrl('http://127.0.0.1:8765/tests/settings-import.html'))
QTimer.singleShot(30000, finish)
sys.exit(app.exec())
