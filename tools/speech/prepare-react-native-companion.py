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
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")''')
with (android / "build.gradle").open("a") as output:
    output.write(f'''\nallprojects {{ repositories {{
        exclusiveContent {{
            forRepository {{ maven {{ url = uri({json.dumps(str(root / "target/android-m2"))}) }} }}
            filter {{ includeGroup("dev.bota") }}
        }}
    }} }}\n''')
kotlin = android / "app/src/main/java/com/helloworld"
replace(kotlin / "MainApplication.kt", 'PackageList(this).packages.apply {', 'PackageList(this).packages.apply {\n          add(RecordingLabPackage())')
shutil.copyfile(app / "native/android/MicrophonePermission.kt", kotlin / "MicrophonePermission.kt")
shutil.copyfile(app / "native/android/RecordingLabHost.kt", kotlin / "RecordingLabHost.kt")
native = root / "platforms/android/speech-companion/src/main"
for name in ["NativeLabTransport.kt", "RecordingAudioSupport.kt", "RecordingLabOwner.kt", "RecordingLabBridge.kt"]:
    shutil.copyfile(native / "kotlin/dev/bota/speech/companion" / name, kotlin / name)
shutil.copytree(native / "res/xml", android / "app/src/main/res/xml", dirs_exist_ok=True)
shutil.copyfile(native / "res/drawable/companion_icon.xml", android / "app/src/main/res/drawable/companion_icon.xml")
replace(android / "app/src/main/res/values/strings.xml", 'Hello App Display Name', 'Bota Recording')
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
for name in ["LabTransport.swift", "RecordingAudioSupport.swift", "RecordingLabOwner.swift", "RecordingLabBridge.swift"]:
    shutil.copyfile(root / "platforms/apple-speech-livekit/Examples/SpeechCompanion" / name, runner / name)
with (runner / "Info.plist").open('rb') as stream:
    info = plistlib.load(stream)
info['CFBundleDisplayName'] = 'Bota Recording'
info['NSMicrophoneUsageDescription'] = 'Capture your voice after you start recording.'
info.pop('NSLocationWhenInUseUsageDescription', None)
with (runner / "Info.plist").open('wb') as stream:
    plistlib.dump(info, stream)
shutil.move(ios / "_xcode.env", ios / ".xcode.env")
print(app)
