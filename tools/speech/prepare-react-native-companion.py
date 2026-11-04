#!/usr/bin/env python3
"""Prepare ignored platform projects from the exact npm-locked RN template."""
from pathlib import Path
import plistlib
import shutil
import sys

root = Path(sys.argv[1]).resolve()
app = root / "tests/consumers/react-native-speech"
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
        'implementation("com.facebook.react:react-android")\n    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")')
kotlin = android / "app/src/main/java/com/helloworld"
replace(kotlin / "MainApplication.kt", 'import android.app.Application',
        'import android.app.Application\nimport com.livekit.reactnative.LiveKitReactNative\nimport com.livekit.reactnative.audio.AudioType')
replace(kotlin / "MainApplication.kt", 'PackageList(this).packages.apply {', 'PackageList(this).packages.apply {\n          add(SpeechLabPackage())')
replace(kotlin / "MainApplication.kt", 'loadReactNative(this)', 'LiveKitReactNative.setup(this, AudioType.CommunicationAudioType())\n    loadReactNative(this)')
shutil.copyfile(app / "native/android/SpeechLabHost.kt", kotlin / "SpeechLabHost.kt")
native = root / "platforms/android/speech-companion/src/main"
shutil.copyfile(native / "kotlin/dev/bota/speech/companion/NativeLabTransport.kt", kotlin / "NativeLabTransport.kt")
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
podfile = ios / "Podfile"
podfile.write_text("source 'https://github.com/livekit/podspecs.git'\nsource 'https://cdn.cocoapods.org/'\n\n" + podfile.read_text())
runner = ios / "SpeechCompanion"
for source in (app / "native/ios").iterdir():
    shutil.copyfile(source, runner / source.name)
shutil.copyfile(root / "platforms/apple-speech-livekit/Examples/SpeechCompanion/LabTransport.swift", runner / "LabTransport.swift")
replace(runner / "AppDelegate.swift", 'import UIKit', 'import UIKit\nimport livekit_react_native')
replace(runner / "AppDelegate.swift", 'let delegate = ReactNativeDelegate()', 'LivekitReactNative.setup()\n    let delegate = ReactNativeDelegate()')
with (runner / "Info.plist").open('rb') as stream:
    info = plistlib.load(stream)
info['CFBundleDisplayName'] = 'Bota Conversation'
info['NSMicrophoneUsageDescription'] = 'Send your voice to the conversation after you enable the microphone.'
info.pop('NSLocationWhenInUseUsageDescription', None)
with (runner / "Info.plist").open('wb') as stream:
    plistlib.dump(info, stream)
shutil.move(ios / "_xcode.env", ios / ".xcode.env")
print(app)
