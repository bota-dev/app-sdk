"""Install maintained App files into a disposable Flutter-generated consumer."""
import json
import plistlib
import re
import shutil
import sys
from pathlib import Path

root, app = (Path(value).resolve() for value in sys.argv[1:3])
source = root / "tests/consumers/flutter-speech"
native = app / "native"
plugin = native / "bota_app_sdk"
shutil.copytree(root / "frameworks/flutter/bota_app_sdk", plugin, dirs_exist_ok=True,
                ignore=shutil.ignore_patterns(".dart_tool", "build", "example", ".gradle"))
shutil.copytree(source / "lib", app / "lib", dirs_exist_ok=True)
(app / "pubspec.yaml").write_text((source / "pubspec.yaml").read_text().replace(
    "path: ../../../frameworks/flutter/bota_app_sdk", "path: native/bota_app_sdk"))
(app / "pubspec.lock").write_text((source / "pubspec.lock").read_text().replace(
    'path: "../../../frameworks/flutter/bota_app_sdk"', 'path: "native/bota_app_sdk"'))
version = re.search(r'^version = "([^"]+)"', (root / "sdk-version.toml").read_text(), re.M).group(1)

def replace(path, old, new):
    text = path.read_text()
    if old not in text:
        raise SystemExit(f"Consumer template changed: {path.name}")
    path.write_text(text.replace(old, new))

android = app / "android"
kotlin = android / "app/src/main/kotlin/dev/bota/speech/companion"
kotlin.mkdir(parents=True, exist_ok=True)
shutil.copyfile(source / "android/FlutterCompanionActivity.kt", kotlin / "FlutterCompanionActivity.kt")
for name in ["LabHost.kt", "NativeLabTransport.kt", "FlutterLabOwner.kt"]:
    shutil.copyfile(root / "platforms/android/speech-companion/src/main/kotlin/dev/bota/speech/companion" / name, kotlin / name)
xml = android / "app/src/main/res/xml"
xml.mkdir(parents=True, exist_ok=True)
for name in ["network_security_config.xml", "data_extraction_rules.xml"]:
    shutil.copyfile(root / "platforms/android/speech-companion/src/main/res/xml" / name, xml / name)
manifest = android / "app/src/main/AndroidManifest.xml"
replace(manifest, '<application', '<uses-permission android:name="android.permission.RECORD_AUDIO"/>\n    <uses-permission android:name="android.permission.INTERNET"/>\n    <application android:allowBackup="false" android:fullBackupContent="false" android:dataExtractionRules="@xml/data_extraction_rules" android:networkSecurityConfig="@xml/network_security_config"')
replace(manifest, 'android:name="${applicationName}"', 'android:name="dev.bota.speech.companion.FlutterCompanionApplication"')
replace(manifest, 'android:name=".MainActivity"', 'android:name="dev.bota.speech.companion.FlutterCompanionActivity"')
replace(manifest, 'android:label="bota_speech_companion"', 'android:label="Bota Conversation"')
build = android / "app/build.gradle.kts"
replace(build, 'namespace = "dev.bota.bota_speech_companion"', 'namespace = "dev.bota.speech.companion"')
replace(build, 'applicationId = "dev.bota.bota_speech_companion"', 'applicationId = "dev.bota.speech.fluttercompanion"')
replace(build, "minSdk = flutter.minSdkVersion", "minSdk = 26")
replace(build, "compileSdk = flutter.compileSdkVersion", "compileSdk = 36")
replace(build, "targetSdk = flutter.targetSdkVersion", "targetSdk = 36")
aar = root / "platforms/android/speech-livekit/build/outputs/aar/speech-livekit-release.aar"
with build.open("a") as output:
    output.write(f'''\ndependencies {{
    implementation(files({json.dumps(str(aar))}))
    implementation("dev.bota:bota-app-sdk:{version}")
    implementation("io.livekit:livekit-android:2.29.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}}
''')
repository = root / "target/android-m2"
replace(android / "build.gradle.kts", "repositories {", f'''repositories {{
        exclusiveContent {{
            forRepository {{ maven {{ url = uri({json.dumps(str(repository))}) }} }}
            filter {{ includeGroup("dev.bota") }}
        }}
        exclusiveContent {{
            forRepository {{ maven {{ url = uri("https://jitpack.io") }} }}
            filter {{ includeVersion("com.github.davidliu", "audioswitch", "039a35aefab7747c557242fa216c9ea11743b604") }}
        }}''')

# Both Swift packages refer to the exact same local SDK identity. Public package
# manifests remain unchanged; the override exists only in this disposable App.
apple = root / "platforms/apple"
replace(plugin / "ios/bota_app_sdk/Package.swift", f'''url: "https://github.com/bota-dev/app-sdk.git",
      exact: "{version}"''', f'''name: "app-sdk", path: {json.dumps(str(apple))}''')
speech = native / "speech-livekit"
shutil.copytree(root / "platforms/apple-speech-livekit/Sources", speech / "Sources", dirs_exist_ok=True)
(speech / "Package.swift").write_text(f'''// swift-tools-version: 6.1
import PackageDescription
let package = Package(name: "BotaSpeechLiveKit", platforms: [.iOS(.v15)],
    products: [.library(name: "BotaSpeechLiveKit", targets: ["BotaSpeechLiveKit"])],
    dependencies: [.package(name: "app-sdk", path: {json.dumps(str(apple))}),
        .package(url: "https://github.com/livekit/client-sdk-swift.git", exact: "2.18.0")],
    targets: [.target(name: "BotaSpeechLiveKit", dependencies: [
        .product(name: "BotaAppSDK", package: "app-sdk"),
        .product(name: "LiveKit", package: "client-sdk-swift")])], swiftLanguageModes: [.v6])
''')
runner = app / "ios/Runner"
for name in ["AppDelegate.swift", "SceneDelegate.swift"]:
    shutil.copyfile(source / "ios" / name, runner / name)
for name in ["LabHost.swift", "FlutterLabOwner.swift"]:
    shutil.copyfile(root / "platforms/apple-speech-livekit/Examples/SpeechCompanion" / name, runner / name)
info = runner / "Info.plist"
with info.open("rb") as handle:
    metadata = plistlib.load(handle)
metadata["CFBundleDisplayName"] = "Bota Conversation"
metadata["NSMicrophoneUsageDescription"] = "Share your voice with your conversation when you enable the microphone."
metadata["NSAppTransportSecurity"] = {"NSAllowsLocalNetworking": True}
with info.open("wb") as handle:
    plistlib.dump(metadata, handle)
lock = app / "ios/Runner.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
lock.parent.mkdir(parents=True, exist_ok=True)
shutil.copyfile(root / "platforms/apple-speech-livekit/Package.resolved", lock)
