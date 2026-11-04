#!/usr/bin/env python3
"""Prepare ignored platform projects from the exact npm-locked RN template."""
from pathlib import Path
import json
import plistlib
import re
import shutil
import sys

root = Path(sys.argv[1]).resolve()
app = root / "tests/consumers/react-native-speech"
version = re.search(r'^version = "([^"]+)"', (root / "sdk-version.toml").read_text(), re.M).group(1)
template = app / "node_modules/@react-native-community/template/template"
for platform in ["android", "ios"]:
    destination = app / platform
    if destination.exists():
        shutil.rmtree(destination)
    for source in (template / platform).rglob("*"):
        if not source.is_file():
            continue
        relative = str(source.relative_to(template / platform)).replace("HelloWorld", "SpeechCompanion")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            text = source.read_text()
        except UnicodeDecodeError:
            shutil.copyfile(source, target)
        else:
            target.write_text(text.replace("HelloWorld", "SpeechCompanion").replace("com.helloworld", "dev.bota.speech.companion"))

def replace(path, before, after):
    text = path.read_text()
    if before not in text:
        raise RuntimeError(f"Template changed: {path.name}")
    path.write_text(text.replace(before, after))

android = app / "android"
(android / "gradlew").chmod(0o755)
replace(android / "build.gradle", 'minSdkVersion = 24', 'minSdkVersion = 26')
# Use the repository's installed and qualified native toolchain.
replace(android / "build.gradle", 'ndkVersion = "27.1.12297006"', 'ndkVersion = "28.2.13676358"')
replace(android / "build.gradle", 'buildToolsVersion = "36.0.0"', 'buildToolsVersion = "35.0.0"')
replace(android / "app/build.gradle", 'applicationId "dev.bota.speech.companion"', 'applicationId "dev.bota.speech.rncompanion"')
replace(android / "app/build.gradle", "file('debug.keystore')", "file('speech-debug.keystore')")
replace(android / "app/build.gradle", 'implementation("com.facebook.react:react-android")',
        f'''implementation("com.facebook.react:react-android")
    implementation("dev.bota:bota-app-sdk:{version}")
    implementation(files({json.dumps(str(root / "platforms/android/speech-livekit/build/outputs/aar/speech-livekit-release.aar"))}))
    implementation("io.livekit:livekit-android:2.29.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")''')
with (android / "build.gradle").open("a") as output:
    output.write(f'''\nallprojects {{ repositories {{
        exclusiveContent {{
            forRepository {{ maven {{ url = uri({json.dumps(str(root / "target/android-m2"))}) }} }}
            filter {{ includeGroup("dev.bota") }}
        }}
        exclusiveContent {{
            forRepository {{ maven {{ url = uri("https://jitpack.io") }} }}
            filter {{ includeVersion("com.github.davidliu", "audioswitch", "039a35aefab7747c557242fa216c9ea11743b604") }}
        }}
    }} }}\n''')
kotlin = android / "app/src/main/java/com/helloworld"
replace(kotlin / "MainApplication.kt", 'PackageList(this).packages.apply {', 'PackageList(this).packages.apply {\n          add(SpeechLabPackage())')
shutil.copyfile(app / "native/android/SpeechLabHost.kt", kotlin / "SpeechLabHost.kt")
native = root / "platforms/android/speech-companion/src/main"
for name in ["NativeLabTransport.kt", "LabHost.kt", "LabOriginal.kt", "ReactNativeLabOwner.kt"]:
    shutil.copyfile(native / "kotlin/dev/bota/speech/companion" / name, kotlin / name)
shutil.copytree(native / "res/xml", android / "app/src/main/res/xml", dirs_exist_ok=True)
shutil.copyfile(native / "res/drawable/companion_icon.xml", android / "app/src/main/res/drawable/companion_icon.xml")
replace(android / "app/src/main/res/values/strings.xml", 'Hello App Display Name', 'Bota Conversation')
manifest = android / "app/src/main/AndroidManifest.xml"
replace(manifest, '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">')
replace(manifest, '<uses-permission android:name="android.permission.INTERNET" />',
        '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.RECORD_AUDIO" />\n    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />\n    <uses-permission android:name="android.permission.CAMERA" tools:node="remove" />\n    <uses-feature android:name="android.hardware.microphone" android:required="false" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />')
replace(manifest, '@mipmap/ic_launcher_round', '@drawable/companion_icon')
replace(manifest, '@mipmap/ic_launcher', '@drawable/companion_icon')
replace(manifest, 'android:usesCleartextTraffic="${usesCleartextTraffic}"',
        'android:networkSecurityConfig="@xml/network_security_config" android:fullBackupContent="false" android:dataExtractionRules="@xml/data_extraction_rules"')

ios = app / "ios"
runner = ios / "SpeechCompanion"
for source in (app / "native/ios").iterdir():
    shutil.copyfile(source, runner / source.name)
for name in ["LabTransport.swift", "LabHost.swift", "LabOriginal.swift", "ReactNativeLabOwner.swift"]:
    shutil.copyfile(root / "platforms/apple-speech-livekit/Examples/SpeechCompanion" / name, runner / name)
speech = ios / "native/speech-livekit"
shutil.copytree(root / "platforms/apple-speech-livekit/Sources", speech / "Sources", dirs_exist_ok=True)
(speech / "Package.swift").write_text(f'''// swift-tools-version: 6.1
import PackageDescription
let package = Package(name: "BotaSpeechLiveKit", platforms: [.iOS(.v15)],
    products: [.library(name: "BotaSpeechLiveKit", targets: ["BotaSpeechLiveKit"])],
    dependencies: [.package(name: "app-sdk", path: {json.dumps(str(root / "platforms/apple"))}),
        .package(url: "https://github.com/livekit/client-sdk-swift.git", exact: "2.18.0")],
    targets: [.target(name: "BotaSpeechLiveKit", dependencies: [
        .product(name: "BotaAppSDK", package: "app-sdk"), .product(name: "LiveKit", package: "client-sdk-swift")])],
    swiftLanguageModes: [.v6])
''')
lock = ios / "SpeechCompanion.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
lock.parent.mkdir(parents=True, exist_ok=True)
shutil.copyfile(root / "platforms/apple-speech-livekit/Package.resolved", lock)
with (runner / "Info.plist").open('rb') as stream:
    info = plistlib.load(stream)
info['CFBundleDisplayName'] = 'Bota Conversation'
info['NSMicrophoneUsageDescription'] = 'Send your voice to the conversation after you enable the microphone.'
info.pop('NSLocationWhenInUseUsageDescription', None)
with (runner / "Info.plist").open('wb') as stream:
    plistlib.dump(info, stream)
shutil.move(ios / "_xcode.env", ios / ".xcode.env")
print(app)
