#!/usr/bin/env python3
"""Offline native transport checks using cached SDK dependencies and temporary keys.

Requires OpenSSL, JDK 17 and cached Gradle dependencies for Android; Swift 6 and
Apple Command Line Tools for Apple. This does not join WiFi or qualify a phone.
"""
import argparse
import glob
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def run(args):
    subprocess.run([str(arg) for arg in args], cwd=ROOT, check=True, timeout=120)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=['apple', 'android', 'both'], default='both')
    parser.add_argument('--bridge', action='store_true', help='Also compile generated RN bridge and run Apple lifecycle checks')
    options = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='bota-local-wifi-') as temporary:
        work = Path(temporary)
        apple = options.platform in ('apple', 'both')
        android = options.platform in ('android', 'both')
        if apple:
            run(['xcrun', 'swiftc', '-parse-as-library', '-swift-version', '6', '-warnings-as-errors',
                 '-module-cache-path', work / 'swift-cache',
                 'platforms/apple/Sources/BotaAppSDK/LocalWiFi/LocalWiFiHTTP.swift',
                 'tools/local-wifi/AppleTransportChecks.swift', '-o', work / 'apple-check'])
            if options.bridge:
                run(['xcrun', 'swiftc', '-parse-as-library', '-swift-version', '6', '-warnings-as-errors',
                     '-module-cache-path', work / 'swift-cache', '-emit-module', '-emit-library', '-module-name', 'BotaAppSDK',
                     'platforms/apple/Sources/BotaAppSDK/LocalWiFi/LocalWiFiHTTP.swift',
                     '-emit-module-path', work / 'BotaAppSDK.swiftmodule', '-o', work / 'libBotaAppSDK.dylib'])
                run(['xcrun', 'swiftc', '-parse-as-library', '-swift-version', '6', '-warnings-as-errors',
                     '-module-cache-path', work / 'swift-cache', '-I', work, '-L', work, '-lBotaAppSDK',
                     '-Xlinker', '-rpath', '-Xlinker', work,
                     'frameworks/react-native/ios/BotaLocalWifiTransportBridge.swift',
                     'tools/local-wifi/AppleBridgeChecks.swift', '-o', work / 'apple-bridge-check'])
                run([work / 'apple-bridge-check'])
                standalone = ROOT / 'frameworks/react-native/native-io/generated/apple'
                run(['xcrun', 'swiftc', '-parse-as-library', '-swift-version', '6', '-warnings-as-errors',
                     '-D', 'BOTA_LOCAL_WIFI_STANDALONE', '-module-cache-path', work / 'swift-standalone-cache',
                     standalone / 'LocalWiFiHTTP.swift', standalone / 'LocalWiFiHotspot.swift',
                     standalone / 'BotaLocalWifiTransportBridge.swift',
                     'tools/local-wifi/AppleBridgeChecks.swift', '-o', work / 'apple-standalone-check'])
                run([work / 'apple-standalone-check'])
        if android:
            cache = Path(os.environ.get('GRADLE_USER_HOME', str(Path.home() / '.gradle'))) / 'caches/modules-2/files-2.1'

            def jar(path):
                files = sorted(glob.glob(str(cache / path / '*' / '*.jar')))
                if not files:
                    raise RuntimeError('Missing cached dependency: ' + path)
                return files[0]

            compiler = [jar('org.jetbrains.kotlin/' + name + '/2.1.20') for name in
                        ['kotlin-compiler-embeddable', 'kotlin-stdlib', 'kotlin-script-runtime', 'kotlin-daemon-embeddable']]
            compiler += [jar('org.jetbrains.intellij.deps/trove4j/1.0.20200330'),
                         jar('org.jetbrains/annotations/13.0'),
                         jar('org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm/1.8.0')]
            sdk = Path(os.environ.get('ANDROID_HOME', str(Path.home() / 'Library/Android/sdk')))
            android_jar = sdk / 'platforms/android-36/android.jar'
            if not android_jar.is_file():
                raise RuntimeError('Set ANDROID_HOME to an installed Android SDK with API 36')
            java = Path(os.environ['JAVA_HOME']) / 'bin/java' if 'JAVA_HOME' in os.environ else shutil.which('java')
            cp = [jar('org.jetbrains.kotlin/kotlin-stdlib/2.1.20'), jar('com.squareup.okhttp3/okhttp/4.12.0'),
                  jar('com.squareup.okio/okio-jvm/3.6.0'), str(android_jar), jar('org.jetbrains/annotations/13.0')]
            sources = sorted((ROOT / 'platforms/android/sdk/src/main/kotlin/dev/bota/sdk/localwifi').glob('*.kt'))
            run([java, '-cp', os.pathsep.join(compiler), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
                 '-no-stdlib', '-no-reflect', '-Werror', '-jvm-target', '17', '-classpath', os.pathsep.join(cp),
                 '-d', work / 'android-check.jar'] + sources + ['tools/local-wifi/AndroidTransportChecks.kt'])
            cp.insert(0, str(work / 'android-check.jar'))
            if options.bridge:
                def aar(path, name):
                    files = sorted(glob.glob(str(cache / path / '*' / '*.aar')))
                    if not files:
                        raise RuntimeError('Missing cached AAR: ' + path)
                    output = work / (name + '.jar')
                    with zipfile.ZipFile(files[0]) as archive:
                        output.write_bytes(archive.read('classes.jar'))
                    return str(output)

                bridge_cp = cp + [aar('com.facebook.react/react-android/0.86.3', 'react'),
                                  aar('com.facebook.fbjni/fbjni/0.7.0', 'fbjni'),
                                  jar('com.facebook.yoga/proguard-annotations/1.19.0'),
                                  jar('com.facebook.infer.annotation/infer-annotation/0.18.0'),
                                  jar('androidx.annotation/annotation-jvm/1.9.1'),
                                  jar('org.jetbrains.kotlin/kotlin-annotations-jvm/1.3.72'),
                                  jar('com.google.code.findbugs/jsr305/3.0.2')]
                run(['node', 'frameworks/react-native/scripts/generate-codegen.mjs', '--output', work / 'codegen'])
                classes = work / 'classes'
                classes.mkdir()
                javac = Path(java).with_name('javac')
                run([javac, '-Werror', '-cp', os.pathsep.join(bridge_cp), '-d', classes,
                     work / 'codegen/android/java/dev/bota/sdk/reactnative/NativeBotaLocalWifiTransportSpec.java'])
                bridge_cp.insert(0, str(classes))
                run([java, '-cp', os.pathsep.join(compiler), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
                     '-no-stdlib', '-no-reflect', '-Werror', '-jvm-target', '17', '-classpath', os.pathsep.join(bridge_cp),
                     '-d', work / 'android-bridge.jar',
                     'frameworks/react-native/native-io/generated/android/BotaLocalWifiTransportModule.kt',
                     'frameworks/react-native/native-io/android/src/main/java/dev/bota/sdk/reactnative/localwifi/BotaLocalWifiPackage.kt'])
                print('Generated RN spec and Android module compile passed against React Android 0.86.3 and API 36')
        for algorithm in ['ec', 'rsa']:
            cert = work / (algorithm + '.pem')
            key = work / (algorithm + '.key')
            key_args = ['ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'] if algorithm == 'ec' else ['rsa:2048']
            subprocess.run(['openssl', 'req', '-x509', '-newkey'] + key_args +
                           ['-nodes', '-keyout', str(key), '-out', str(cert), '-subj', '/CN=localhost', '-days', '1'],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
            if apple:
                run(['openssl', 'x509', '-in', cert, '-outform', 'DER', '-out', work / 'cert.der'])
                public = subprocess.run(['openssl', 'x509', '-in', str(cert), '-pubkey', '-noout'],
                                        check=True, stdout=subprocess.PIPE).stdout
                subprocess.run(['openssl', 'pkey', '-pubin', '-outform', 'DER', '-out', str(work / 'spki.der')],
                               input=public, check=True)
                run([work / 'apple-check', work / 'cert.der', work / 'spki.der'])
            if android:
                run(['openssl', 'pkcs12', '-export', '-inkey', key, '-in', cert,
                     '-out', work / 'peer.p12', '-passout', 'pass:test-only'])
                run([java, '-cp', os.pathsep.join(cp), 'dev.bota.sdk.localwifi.AndroidTransportChecksKt', cert, work / 'peer.p12'])
        print('Native component checks passed for ' + options.platform + '; phone qualification remains separate.')


if __name__ == '__main__':
    main()
