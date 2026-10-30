import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const require = createRequire(import.meta.url);

test('local WiFi native entry selects only OS transport registration', () => {
  const entry = require('../native-io/react-native.config.cjs');
  assert(existsSync(resolve(entry.root, 'BotaLocalWifiTransport.podspec')));
  assert(existsSync(resolve(entry.root, entry.platforms.android.sourceDir, 'build.gradle')));
  assert.equal(entry.platforms.android.packageInstance, 'new BotaLocalWifiPackage()');
  const registration = read('native-io/android/src/main/java/dev/bota/sdk/reactnative/localwifi/BotaLocalWifiPackage.kt');
  assert.match(registration, /BotaLocalWifiTransportModule/);
  assert.doesNotMatch(registration, /BotaDeviceSDKModule|BotaUploadV2BackendModule/);
  const gradle = read('native-io/android/build.gradle');
  assert.doesNotMatch(gradle, /bota-app-sdk|uniffi|coroutines/);
  const pod = read('native-io/BotaLocalWifiTransport.podspec');
  assert.doesNotMatch(pod, /spm_dependency|BotaAppSDK|BotaDeviceSDK\.podspec/);
  assert.match(pod, /BOTA_LOCAL_WIFI_STANDALONE/);
});

test('packaged OS sources are exact verified copies of their canonical sources', () => {
  const result = spawnSync(process.execPath, ['scripts/prepare-local-wifi-native.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('npm payload includes the standalone native target and all IO source assets', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.exports['./native-io'], './native-io/react-native.config.cjs');
  assert(pkg.files.includes('native-io/'));
  assert.match(pkg.scripts.build, /prepare-local-wifi-native.*--check/);
  const manifest = read('native-io/android/src/main/AndroidManifest.xml');
  for (const permission of ['INTERNET', 'ACCESS_NETWORK_STATE', 'CHANGE_NETWORK_STATE', 'ACCESS_WIFI_STATE',
    'CHANGE_WIFI_STATE', 'ACCESS_FINE_LOCATION', 'NEARBY_WIFI_DEVICES']) assert(manifest.includes(`android.permission.${permission}`));
  assert.match(manifest, /neverForLocation/);
});
