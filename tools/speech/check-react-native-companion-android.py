#!/usr/bin/env python3
"""Reject mismatched Fabric prop layouts in the compiled internal Android App."""
import json
from pathlib import Path
import shlex
import sys

app = Path(sys.argv[1])
flag = '-DRN_SERIALIZABLE_STATE'
for abi in ('arm64-v8a', 'x86_64'):
    manifests = list((app / '.cxx' / 'RelWithDebInfo').glob(f'*/{abi}/compile_commands.json'))
    if len(manifests) != 1:
        raise RuntimeError(f'Expected one current release compilation database for {abi}')
    entries = json.loads(manifests[0].read_text())
    host = [entry for entry in entries if entry['file'].endswith('/OnLoad.cpp')]
    components = [entry for entry in entries if '/react-native-safe-area-context/' in entry['file']]
    if not host or not components:
        raise RuntimeError(f'Missing App or safe-area compilation evidence for {abi}')
    for entry in host + components:
        arguments = entry.get('arguments') or shlex.split(entry['command'])
        if flag not in arguments:
            raise RuntimeError(f'Fabric property layout mismatch for {abi}: {entry["file"]} omits {flag}')
    print(f'Fabric property layout agrees for {abi}: {len(components)} component translation units')
