#!/usr/bin/env python3
"""macOS host validation using the real Rust ABI; does not build iOS artifacts."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
subprocess.run(['cargo', 'build', '-p', 'bota-device-sdk-ffi'], cwd=root, check=True)
with tempfile.TemporaryDirectory(prefix='bota-marker-apple-') as temporary:
    build = Path(temporary)
    header = root / 'bindings/device-sdk-ffi/include/bota_device_sdk.h'
    (build / 'module.modulemap').write_text(f'module BotaDeviceSDKC {{ header "{header}" export * }}\n')
    sources = sorted((root / 'platforms/apple/Sources/BotaAppSDK').rglob('*.swift'))
    subprocess.run(['swiftc', '-swift-version', '6', '-parse-as-library', '-I', str(build),
                    *map(str, sources), str(root / 'tools/apple/tests/recording-markers-host.swift'),
                    str(root / 'target/debug/libbota_device_sdk_ffi.a'), '-framework', 'Security',
                    '-framework', 'SystemConfiguration', '-o', str(build / 'tests')], check=True)
    subprocess.run([str(build / 'tests')], check=True)
