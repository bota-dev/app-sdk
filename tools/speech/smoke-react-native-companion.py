#!/usr/bin/env python3
"""Exercise the bundled internal App on an already booted disposable emulator."""
import re
import subprocess
import sys
import time
from pathlib import Path
import xml.etree.ElementTree as ET

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
    return ET.fromstring(data)

def wait_for(predicate):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        tree = screen()
        if predicate(tree):
            return tree
        time.sleep(1)
    raise RuntimeError('The bundled conversation App did not reach the expected screen')

def matching(tree, attribute, value):
    return next((node for node in tree.iter('node') if node.get(attribute) == value), None)

def labelled(tree, value):
    node = matching(tree, 'text', value)
    return node if node is not None else matching(tree, 'content-desc', value)

def control(value):
    for _ in range(6):
        node = labelled(screen(), value)
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
width, height = map(int, re.findall(r'(\d+)x(\d+)', run('shell', 'wm', 'size').decode())[-1])
try:
    run('shell', 'am', 'start', '-W', '-n', package + '/dev.bota.speech.companion.MainActivity')
    wait_for(lambda value: labelled(value, 'Listen in your language.') is not None)
    (output / 'conversation.png').write_bytes(run('exec-out', 'screencap', '-p'))
    tap(control('Role access code'))
    run('shell', 'input', 'text', 'x' * 32)
    run('shell', 'input', 'keyevent', 'BACK')
    tap(control('Join conversation'))
    # The error is below the listening controls on smaller screens.
    for _ in range(4):
        run('shell', 'input', 'swipe', str(width // 2), str(height * 3 // 4), str(width // 2), str(height // 3), '400')
    wait_for(lambda value: any('Could not join.' in node.get('text', '') + node.get('content-desc', '') for node in value.iter('node')))
    (output / 'unavailable-host.png').write_bytes(run('exec-out', 'screencap', '-p'))
    run('shell', 'input', 'keyevent', 'HOME')
    print('Bundled RN App rendered, handled an unavailable loopback host and accepted background navigation. No media was started.')
finally:
    run('shell', 'am', 'force-stop', package)
