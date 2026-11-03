"""Stage unchanged shipping Swift sources with the actual host Rust library."""
import json
import re
import shutil
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
stage = root / "target/apple-speech-livekit-host"
sdk = stage / "Sources/BotaAppSDK"
c = stage / "Sources/BotaDeviceSDKC"
sdk.mkdir(parents=True, exist_ok=True)
(c / "include").mkdir(parents=True, exist_ok=True)
for source in [*root.glob("platforms/apple/Sources/BotaAppSDK/Speech/*.swift"),
               root / "platforms/apple/Sources/BotaAppSDK/Core/CoreError.swift",
               root / "platforms/apple/Sources/BotaAppSDK/Core/NativeSpeechPolicy.swift"]:
    shutil.copyfile(source, sdk / source.name)
for source in (root / "bindings/device-sdk-ffi/include").glob("*.h"):
    shutil.copyfile(source, c / "include" / source.name)
(c / "bridge.c").write_text("/* Rust supplies the shipping C ABI implementation. */\n", encoding="utf-8")
for name, source in [
    ("Sources/BotaSpeechLiveKit", "platforms/apple-speech-livekit/Sources/BotaSpeechLiveKit"),
    ("Sources/SpeechCompanion", "platforms/apple-speech-livekit/Examples/SpeechCompanion"),
    ("Sources/SpeechCompanionApp", "platforms/apple-speech-livekit/Examples/App"),
]:
    link = stage / name
    link.parent.mkdir(parents=True, exist_ok=True)
    if not link.exists():
        link.symlink_to(root / source, target_is_directory=True)
checks = stage / "HostChecks"
checks.mkdir(exist_ok=True)
calls = []
for source in (root / "platforms/apple-speech-livekit/Tests/BotaSpeechLiveKitTests").glob("*.swift"):
    if source.name == "XCTestChecks.swift":
        continue
    shutil.copyfile(source, checks / source.name)
    contents = source.read_text()
    owner = re.search(r"final class (\w+Checks)", contents).group(1)
    for method in re.findall(r"func (test\w+)\(\) async throws", contents):
        calls += [f'write("RUN {method}")', f"try await {owner}().{method}()", f'write("PASS {method}")']
(checks / "Runner.swift").write_text("import Foundation\nimport Darwin\n@main struct HostChecks {\n" +
    'static func write(_ text: String) { FileHandle.standardOutput.write(Data((text + "\\n").utf8)) }\n' +
    "static func main() async { do {\n" + "\n".join(calls) +
    '\n} catch { write("FAILED: \\(error)"); exit(1) }\n}\n}\n', encoding="utf-8")
manifest = '''// swift-tools-version: 6.1
import PackageDescription
let package = Package(name: "BotaSpeechHostCheck", platforms: [.macOS(.v13)],
    dependencies: [.package(url: "https://github.com/livekit/client-sdk-swift.git", exact: "2.18.0")],
    targets: [
        .target(name: "BotaDeviceSDKC"),
        .target(name: "BotaAppSDK", dependencies: ["BotaDeviceSDKC"],
                linkerSettings: [.unsafeFlags([RUST_LIBRARY])]),
        .target(name: "BotaSpeechLiveKit", dependencies: ["BotaAppSDK", .product(name: "LiveKit", package: "client-sdk-swift")]),
        .target(name: "SpeechCompanion", dependencies: ["BotaSpeechLiveKit"]),
        .executableTarget(name: "SpeechCompanionApp", dependencies: ["SpeechCompanion"], exclude: ["Info.plist"]),
        .executableTarget(name: "BotaSpeechLiveKitHostChecks", dependencies: ["BotaSpeechLiveKit", "SpeechCompanion"], path: "HostChecks"),
    ])
'''.replace("RUST_LIBRARY", json.dumps(str(root / "target/debug/libbota_device_sdk_ffi.a")))
(stage / "Package.swift").write_text(manifest, encoding="utf-8")
lock = root / "platforms/apple-speech-livekit/Package.resolved"
if lock.exists():
    shutil.copyfile(lock, stage / "Package.resolved")
