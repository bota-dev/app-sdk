import { readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Compile production BYO workflow sources and exercise the real host Rust/JNI ABI.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const compileSDK = process.argv.length === 3 && process.argv[2] === '--compile-sdk';
const compileOnly = compileSDK || process.argv.length === 3 && process.argv[2] === '--compile-only';
if (process.platform === 'win32' && !compileOnly) throw new Error('Run on Linux/macOS: host durability tests require POSIX directory fsync; --compile-only does not run tests.');
if (!process.env.JAVA_HOME) throw new Error('Set JAVA_HOME to JDK 17.');
const java = join(process.env.JAVA_HOME, 'bin/java');
const cache = join(process.env.GRADLE_USER_HOME ?? join(homedir(), '.gradle'), 'caches/modules-2/files-2.1');
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((f) =>
  f.isDirectory() ? files(join(dir, f.name)) : [join(dir, f.name)]);
const jar = (group, artifact, version) => {
  const path = files(join(cache, group, artifact, version)).find((p) => basename(p) === `${artifact}-${version}.jar`);
  if (!path) throw new Error(`Missing cached ${group}:${artifact}:${version}`);
  return path;
};
const runtime = [
  jar('org.jetbrains.kotlin', 'kotlin-stdlib', '2.1.20'),
  jar('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.10.2'),
  jar('com.squareup.okhttp3', 'okhttp', '4.12.0'),
  jar('com.squareup.okio', 'okio-jvm', '3.6.0'),
  jar('org.json', 'json', '20240303'),
  jar('junit', 'junit', '4.13.2'),
  jar('org.hamcrest', 'hamcrest-core', '1.3'),
  jar('org.jetbrains', 'annotations', '13.0'),
];
const compiler = [
  jar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.1.20'),
  ...runtime,
  jar('org.jetbrains.kotlin', 'kotlin-script-runtime', '2.1.20'),
  jar('org.jetbrains.kotlin', 'kotlin-reflect', '1.6.10'),
  jar('org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330'),
];
if (process.argv.length > 2 && !compileOnly) throw new Error('Usage: test-native-android.mjs [--compile-only|--compile-sdk]');
const output = mkdtempSync(join(tmpdir(), 'bota-upload-android-jvm-'));
function run(args) {
  const result = spawnSync(java, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result.status === 0;
}
try {
  const sourceRoot = join(root, 'platforms/android/sdk/src/main/kotlin/dev/bota/sdk');
  const sources = files(join(sourceRoot, 'internal/byo')).filter(p => p.endsWith('.kt') && !p.endsWith('ByoDeviceSession.kt'));
  sources.push(...files(join(root, 'platforms/android/sdk/src/test/kotlin/dev/bota/sdk/internal/byo')).filter(p => p.endsWith('.kt')));
  for (const name of ['BotaSDKError.kt','internal/DeviceFacadeState.kt','ByoStorage.kt','EncryptedUploadV2Models.kt','model/RecordingModels.kt','model/DeviceModels.kt','model/ConnectionModels.kt','internal/core/ByoRecoveryHost.kt','internal/jni/NativeCoreBridge.kt','internal/jni/NativePacket.kt']) sources.push(join(sourceRoot,name));
  if (compileSDK) {
    if (!process.env.BOTA_ANDROID_JAR) throw new Error('Set BOTA_ANDROID_JAR to the installed Android 36 platform android.jar.');
    sources.length = 0;
    sources.push(...files(join(root,'platforms/android/sdk/src/main/kotlin')).filter(p=>p.endsWith('.kt')));
    sources.push(join(root,'frameworks/react-native/android/src/main/java/dev/bota/sdk/reactnative/upload/UploadModels.kt'));
    sources.push(join(root,'frameworks/react-native/android/src/main/java/dev/bota/sdk/reactnative/upload/ByoBridgeDriver.kt'));
    const config=join(output,'BuildConfig.kt');
    writeFileSync(config,'package dev.bota.sdk\ninternal object BuildConfig { const val BOTA_SDK_VERSION = "source-validation" }\n');
    sources.push(config);
    // Production resolves org.json from Android, not the richer desktop test jar.
    const desktopJSON = jar('org.json', 'json', '20240303');
    runtime.splice(runtime.indexOf(desktopJSON), 1);
    runtime.unshift(process.env.BOTA_ANDROID_JAR);
  }
  if (run(['-cp', compiler.join(delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
    '-Werror', ...(compileSDK ? ['-Xexplicit-api=strict'] : []), '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-classpath', runtime.join(delimiter), '-d', output, ...sources])) {
    if (compileOnly) console.log('Native backend sources/tests compiled; execution not requested.');
    else run(['-Djava.library.path=' + process.env.BOTA_BYO_JNI_DIRECTORY, '-cp', [output, ...runtime].join(delimiter), 'org.junit.runner.JUnitCore', 'dev.bota.sdk.internal.byo.ByoBLECodecTest', 'dev.bota.sdk.internal.byo.ByoBLEHostTest', 'dev.bota.sdk.internal.byo.ByoUploadSessionTest']);
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
