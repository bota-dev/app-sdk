import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Compile the native backend and SDK models together to exercise opaque callbacks.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const compileOnly = process.argv.length === 3 && process.argv[2] === '--compile-only';
if (process.platform === 'win32' && !compileOnly) throw new Error('Run on Linux/macOS: host durability tests require POSIX directory fsync; --compile-only does not run tests.');
const sdk = root;
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
  jar('org.jetbrains.kotlinx', 'kotlinx-coroutines-test-jvm', '1.10.2'),
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
const source = join(root, 'frameworks/react-native/android/src/main/java/dev/bota/sdk/reactnative/upload');
if (process.argv.length > 2 && !compileOnly) throw new Error('Usage: test-upload-backend-android.mjs [--compile-only]');
const output = mkdtempSync(join(tmpdir(), 'bota-upload-android-jvm-'));
function run(args) {
  const result = spawnSync(java, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result.status === 0;
}
try {
  const sources = files(source).filter((p) => p.endsWith('.kt') && basename(p) !== 'BotaUploadV2BackendModule.kt');
  sources.push(...files(join(root, 'tools/react-native/tests')).filter((p) => p.endsWith('.kt')));
  sources.push(join(sdk, 'platforms/android/sdk/src/main/kotlin/dev/bota/sdk/EncryptedUploadV2Models.kt'));
  sources.push(join(sdk, 'platforms/android/sdk/src/main/kotlin/dev/bota/sdk/model/RecordingModels.kt'));
  sources.push(join(sdk, 'platforms/android/sdk/src/main/kotlin/dev/bota/sdk/model/DeviceModels.kt'));
  sources.push(join(sdk, 'platforms/android/sdk/src/main/kotlin/dev/bota/sdk/model/ConnectionModels.kt'));
  sources.push(join(sdk, 'frameworks/react-native/android/src/main/java/dev/bota/sdk/reactnative/BotaDeviceSDKEncryptedUploadV2Materials.kt'));
  // The same JVM run exercises the SDK's real receiver and material registry.
  const sdkMain = join(sdk, 'platforms/android/sdk/src/main/kotlin/dev/bota/sdk');
  for (const file of [
    'internal/core/EncryptedUploadV2ContractModels.kt', 'internal/core/CoreCommand.kt',
    'internal/core/CoreEffect.kt', 'internal/core/CoreHostEvent.kt', 'internal/jni/NativePacket.kt',
    'internal/host/CoreHost.kt', 'internal/host/EncryptedUploadV2Host.kt',
    'internal/host/EncryptedUploadV2MaterialRegistry.kt', 'internal/bluetooth/EncryptedUploadV2TransferReceiver.kt',
    'internal/core/EncryptedUploadV2CapabilityReader.kt',
    'BotaSDKError.kt', 'RecordingControlCommand.kt', 'internal/core/CoreModelMapper.kt', 'internal/core/Protocol.kt',
    'internal/jni/NativeCoreBridge.kt', 'internal/bluetooth/BluetoothDriver.kt',
    'internal/bluetooth/BotaBluetoothUUIDs.kt', 'internal/bluetooth/EncryptedUploadV2TransferControl.kt',
    'internal/bluetooth/EncryptedUploadV2CatalogReader.kt', 'internal/host/JournalStore.kt',
    'internal/host/EncryptedUploadV2CheckpointStore.kt', 'internal/host/EncryptedUploadV2TransferHost.kt',
    'internal/host/EncryptedUploadV2MaterialValidation.kt',
  ]) sources.push(join(sdkMain, file));
  for (const file of ['internal/bluetooth/EncryptedUploadV2TransferReceiverTest.kt',
    'internal/host/EncryptedUploadV2MaterialRegistryTest.kt',
    'internal/host/EncryptedUploadV2TransferHostTest.kt',
    'internal/bluetooth/EncryptedUploadV2CatalogReaderTest.kt',
    'internal/core/EncryptedUploadV2DemoCodecTest.kt']) {
    sources.push(join(sdk, 'platforms/android/sdk/src/test/kotlin/dev/bota/sdk', file));
  }
  sources.push(...files(join(sdkMain, 'model')).filter(p => p.endsWith('.kt') && !sources.includes(p)));
  if (run(['-cp', compiler.join(delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
    '-Werror', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-classpath', runtime.join(delimiter), '-d', output, ...sources])) {
    if (compileOnly) console.log('Native backend sources/tests compiled; execution not requested.');
    else run(['-cp', [output, ...runtime].join(delimiter), 'org.junit.runner.JUnitCore', 'dev.bota.sdk.reactnative.upload.NativeUploadTest',
      'dev.bota.sdk.internal.bluetooth.EncryptedUploadV2TransferReceiverTest',
      'dev.bota.sdk.internal.host.EncryptedUploadV2MaterialRegistryTest',
      'dev.bota.sdk.internal.host.EncryptedUploadV2TransferHostTest',
      'dev.bota.sdk.internal.bluetooth.EncryptedUploadV2CatalogReaderTest',
      'dev.bota.sdk.internal.core.EncryptedUploadV2DemoCodecTest']);
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
