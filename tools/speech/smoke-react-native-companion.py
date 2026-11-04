#!/usr/bin/env python3
"""Exercise the bundled internal App on an already booted disposable emulator."""
import json
import re
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Event, Thread
from defusedxml import ElementTree as ET

adb, apk, destination = sys.argv[1:]
output = Path(destination)
output.mkdir(parents=True, exist_ok=True)
serial = subprocess.check_output([adb, 'get-serialno'], text=True, timeout=10).strip()
if not serial.startswith('emulator-'):
    raise RuntimeError('The speech smoke check only accepts a disposable emulator')
package = 'dev.bota.speech.rncompanion'

def run(*args, timeout=30):
    return subprocess.check_output([adb, '-s', serial, *args], timeout=timeout)

def screen():
    run('shell', 'uiautomator', 'dump', '--compressed', '/sdcard/bota-speech-window.xml')
    data = run('exec-out', 'cat', '/sdcard/bota-speech-window.xml')
    (output / 'window.xml').write_bytes(data)
    return ET.fromstring(data, forbid_dtd=True)

def wait_for(predicate, scroll=False):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        tree = screen()
        if predicate(tree):
            return tree
        if scroll:
            run('shell', 'input', 'swipe', str(width // 2), str(height * 3 // 4), str(width // 2), str(height // 3), '400')
        time.sleep(1)
    raise RuntimeError('The bundled conversation App did not reach the expected screen')

def matching(tree, attribute, value, class_name=None):
    return next((node for node in tree.iter('node') if node.get(attribute) == value and
                 (class_name is None or node.get('class') == class_name)), None)

def labelled(tree, value, class_name=None):
    node = matching(tree, 'text', value, class_name)
    return node if node is not None else matching(tree, 'content-desc', value, class_name)

def control(value, class_name=None):
    for _ in range(6):
        node = labelled(screen(), value, class_name)
        if node is not None:
            return node
        run('shell', 'input', 'swipe', str(width // 2), str(height * 3 // 4), str(width // 2), str(height // 3), '400')
    raise RuntimeError('Required conversation control is not visible')

def tap(node):
    if node is None:
        raise RuntimeError('Required conversation control is missing')
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.attrib['bounds']))
    run('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))

run('install', '-r', str(Path(apk).resolve()), timeout=120)
package_uid = re.search(r'\buid:(\d+)', run('shell', 'cmd', 'package', 'list', 'packages', '-U', package).decode()).group(1)
width, height = map(int, re.findall(r'(\d+)x(\d+)', run('shell', 'wm', 'size').decode())[-1])
# A neutral UI error alone could come from JS validation without native HTTP.
# Observe the exact synthetic request at a disposable loopback fixture as well.
received_join = Event()
class UnavailableHost(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        self.connection.settimeout(2)
        length = int(self.headers.get('Content-Length', '0'))
        body = self.rfile.read(length) if 0 < length <= 512 else b''
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            payload = None
        if (self.path == '/speech-host/join' and
            self.headers.get('Origin') == 'http://127.0.0.1:4173' and
            self.headers.get('X-Speech-Role') == 'a' and self.headers.get('X-Speech-Code') == 'x' * 32 and
            payload == {'captureProfile': 'speech_capture_pcm_v1'}):
            received_join.set()
        payload = b'{"error":{"code":"unavailable"}}'
        self.send_response(503)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

server = HTTPServer(('127.0.0.1', 0), UnavailableHost)
thread = Thread(target=lambda: server.serve_forever(poll_interval=0.1), daemon=True)
thread.start()
try:
    run('reverse', 'tcp:4173', 'tcp:' + str(server.server_port))
    run('logcat', '-c')
    run('logcat', '-b', 'crash', '-c')
    (output / 'launch.txt').write_bytes(run('shell', 'am', 'start', '-W', '-n', package + '/dev.bota.speech.companion.MainActivity'))
    wait_for(lambda value: labelled(value, 'Listen in your language.') is not None)
    (output / 'conversation.png').write_bytes(run('exec-out', 'screencap', '-p'))
    tap(control('Role access code', 'android.widget.EditText'))
    run('shell', 'input', 'text', 'x' * 32)
    run('shell', 'input', 'keyevent', 'BACK')
    tap(control('Join conversation'))
    if not received_join.wait(timeout=15):
        raise RuntimeError('The conversation App did not send the native loopback join request')
    # The error is below the listening controls on smaller screens.
    wait_for(lambda value: any('Could not join.' in node.get('text', '') + node.get('content-desc', '') for node in value.iter('node')), scroll=True)
    (output / 'unavailable-host.png').write_bytes(run('exec-out', 'screencap', '-p'))
    run('shell', 'input', 'keyevent', 'HOME')
    print('Bundled RN App rendered, sent the native loopback join request, handled HTTP 503 and accepted background navigation. No media was started.')
except BaseException:
    # This emulator contains only synthetic fixture data and never opens media.
    # Preserve startup evidence before force-stop destroys the failed process.
    for name, arguments in [
        ('runtime.txt', ('logcat', '-d', '-v', 'threadtime', '--uid=' + package_uid)),
        ('crash.txt', ('logcat', '-b', 'crash', '-d', '-v', 'threadtime')),
        ('failure.png', ('exec-out', 'screencap', '-p')),
    ]:
        try:
            (output / name).write_bytes(run(*arguments))
        except Exception:
            pass
    raise
finally:
    (output / 'host-observation.json').write_text(json.dumps({'originalProfileJoinReceived': received_join.is_set()}) + '\n')
    try:
        run('shell', 'am', 'force-stop', package)
        run('reverse', '--remove', 'tcp:4173')
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
