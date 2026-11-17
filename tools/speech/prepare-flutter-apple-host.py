"""Stage the shipping speech/Pigeon adapter with the real Rust ABI on macOS."""
import json
import re
import shutil
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
stage = root / "target/flutter-speech-apple-host"
plugin = root / "frameworks/flutter/bota_app_sdk/ios"
sdk = stage / "Sources/BotaAppSDK"
c = stage / "Sources/BotaDeviceSDKC"
adapter = stage / "Sources/BotaFlutterSdk"
stub = stage / "Sources/FlutterMacOS"
checks = stage / "Checks"
for generated in (sdk, adapter):
    if generated.exists():
        shutil.rmtree(generated)
for directory in (sdk, c / "include", adapter, stub, checks):
    directory.mkdir(parents=True, exist_ok=True)
shutil.copytree(root / "platforms/apple/Sources/BotaAppSDK", sdk, dirs_exist_ok=True)
for source in (root / "bindings/device-sdk-ffi/include").glob("*.h"):
    shutil.copyfile(source, c / "include" / source.name)
(c / "bridge.c").write_text("/* Rust supplies the shipping C ABI implementation. */\n")
for source in (plugin / "bota_app_sdk/Sources/bota_app_sdk").glob("*.swift"):
    shutil.copyfile(source, adapter / source.name)
# Use the same narrow Flutter API substitute as the existing adapter checks.
# Full CI separately compiles the normal plugin with the actual Flutter engine.
script = (root / "tools/flutter/test-apple-adapter.sh").read_text()
mock = script.split('cat >"$consumer_root/Sources/FlutterMacOS/FlutterMacOS.swift" <<\'EOF\'\n', 1)[1].split('\nEOF', 1)[0]
(stub / "FlutterMacOS.swift").write_text(mock)
source = plugin / "Tests/SpeechBridgeChecks.swift"
shutil.copyfile(source, checks / source.name)
calls = []
for method in re.findall(r"func (test\w+)\(\) async throws", source.read_text()):
    calls += [f'write("RUN {method}")', f"try await SpeechBridgeChecks().{method}()", f'write("PASS {method}")']
(checks / "Runner.swift").write_text("import Foundation\nimport Darwin\n@main @MainActor struct Runner {\n" +
    'static func write(_ text: String) { FileHandle.standardOutput.write(Data((text + "\\n").utf8)) }\n' +
    "static func main() async { do {\n" + "\n".join(calls) +
    '\n} catch { write("FAILED: \\(error)"); exit(1) }\n}\n}\n')
(stage / "Package.swift").write_text('''// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "FlutterSpeechHostChecks", platforms: [.macOS(.v13)], targets: [
    .target(name: "BotaDeviceSDKC"),
    .target(name: "BotaAppSDK", dependencies: ["BotaDeviceSDKC"],
            swiftSettings: [.swiftLanguageMode(.v6)],
            linkerSettings: [.unsafeFlags([RUST_LIBRARY])]),
    .target(name: "FlutterMacOS"),
    .target(name: "BotaFlutterSdk", dependencies: ["BotaAppSDK", "FlutterMacOS"]),
    .executableTarget(name: "FlutterSpeechHostChecks", dependencies: ["BotaFlutterSdk"], path: "Checks",
        swiftSettings: [.unsafeFlags(["-warnings-as-errors"])]),
], swiftLanguageModes: [.v5])
'''.replace("RUST_LIBRARY", json.dumps(str(root / "target/debug/libbota_device_sdk_ffi.a"))))
