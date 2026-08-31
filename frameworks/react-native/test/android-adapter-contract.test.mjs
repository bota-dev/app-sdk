import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Android adapter build is version-synchronized and Codegen-enabled', () => {
  const build = read('../android/build.gradle');
  const manifest = read('../android/src/main/AndroidManifest.xml');

  assert.match(build, /apply plugin: "com\.android\.library"/);
  assert.match(build, /apply plugin: "org\.jetbrains\.kotlin\.android"/);
  assert.match(build, /apply plugin: "com\.facebook\.react"/);
  assert.match(build, /namespace "dev\.bota\.sdk\.reactnative"/);
  assert.match(build, /minSdkVersion: 26/);
  assert.match(build, /compileSdkVersion: 36/);
  assert.match(build, /compileSdkVersion getExtOrDefault\("compileSdkVersion"\)/);
  assert.match(build, /minSdkVersion getExtOrDefault\("minSdkVersion"\)/);
  assert.match(build, /sourceCompatibility JavaVersion\.VERSION_17/);
  assert.match(build, /libraryName = "BotaDeviceSDKSpec"/);
  assert.match(build, /codegenJavaPackageName = "dev\.bota\.sdk\.reactnative"/);
  assert.match(
    build,
    /implementation "\$\{androidMetadata\.mavenCoordinate\}:\$\{packageVersion\}"/
  );
  assert.match(manifest, /<manifest/);
});

test('Android adapter package does not bypass the public facade', () => {
  const packageJson = JSON.parse(read('../package.json'));

  assert.deepEqual(packageJson.bota.android, {
    compileSdkVersion: 36,
    coroutinesVersion: '1.10.2',
    kotlinVersion: '2.1.20',
    mavenCoordinate: 'dev.bota:bota-android-sdk',
    minSdkVersion: 26,
    namespace: 'dev.bota.sdk.reactnative',
  });
  assert.ok(packageJson.files.includes('android/'));
});

test('Android adapter implements the generated lifecycle module and package', () => {
  const lifecycle = read(
    '../android/src/main/java/dev/bota/sdk/reactnative/BotaDeviceSDKAndroidLifecycle.kt'
  );
  const module = read(
    '../android/src/main/java/dev/bota/sdk/reactnative/BotaDeviceSDKModule.kt'
  );
  const packageSource = read(
    '../android/src/main/java/dev/bota/sdk/reactnative/BotaDeviceSDKPackage.kt'
  );
  const combined = `${lifecycle}\n${module}\n${packageSource}`;

  assert.match(module, /class BotaDeviceSDKModule/);
  assert.match(module, /NativeBotaDeviceSDKSpec\(reactContext\)/);
  assert.match(module, /@ReactModule\(name = NativeBotaDeviceSDKSpec\.NAME\)/);
  for (const method of [
    'configure',
    'destroy',
    'deprovision',
    'factoryReset',
    'getCapabilities',
    'getState',
    'listRecordings',
    'observeUploadOwnership',
    'provision',
    'rejectApplicationMaterial',
    'readStatus',
    'resolveFactoryResetGrant',
    'resolveProvisioningMaterial',
    'resumePendingFactoryReset',
    'startStatusUpdates',
    'stopStatusUpdates',
    'syncRecording',
  ]) {
    assert.match(module, new RegExp(`override fun ${method}\\(`));
  }
  assert.match(module, /android_sdk_error/);
  assert.match(packageSource, /class BotaDeviceSDKPackage : BaseReactPackage\(\)/);
  assert.match(packageSource, /isTurboModule = true/);
  assert.doesNotMatch(combined, /NativeCoreBridge|System\.loadLibrary|bota_device_sdk_v1/);
});

test('Android adapter has a packaged-AAR consumer gate in CI', () => {
  const settings = read('../../../tests/conformance/react-native-android-adapter/settings.gradle.kts');
  const consumer = read('../../../tests/conformance/react-native-android-adapter/app/build.gradle.kts');
  const script = read('../../../tools/react-native/test-android-adapter.sh');
  const workflow = read('../../../.github/workflows/ci.yml');

  assert.match(settings, /botaSdkRepository/);
  assert.match(settings, /frameworks\/react-native\/node_modules\/@react-native\/gradle-plugin/);
  assert.match(settings, /project\(":adapter"\)/);
  assert.match(consumer, /id\("com\.facebook\.react"\)/);
  assert.match(script, /--repository/);
  assert.match(script, /shasum -a 256/);
  for (const task of [
    'generateCodegenArtifactsFromSchema',
    'testDebugUnitTest',
    'lintRelease',
    'assembleRelease',
  ]) {
    assert.match(script, new RegExp(`:adapter:${task}`));
  }
  assert.match(workflow, /npm ci[\s\S]*test-android-adapter\.sh --repository target\/android-m2/);
});
