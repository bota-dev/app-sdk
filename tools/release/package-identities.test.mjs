import assert from 'node:assert/strict';
import test from 'node:test';
import { publicPackageIdentifier } from './package-identities.mjs';

const rows = [
  ['apple', 'BotaAppleSDK', 'BotaAppSDK'],
  ['android', 'dev.bota:bota-android-sdk', 'dev.bota:bota-app-sdk'],
  ['react-native', '@bota.dev/react-native-sdk', '@bota.dev/react-native-app-sdk'],
  ['web', '@bota.dev/web-sdk', '@bota.dev/web-app-sdk'],
  ['flutter', 'bota_flutter_sdk', 'bota_app_sdk'],
];

test('package identities distinguish historical and renamed releases', () => {
  for (const [platform, oldName, newName] of rows) {
    assert.equal(publicPackageIdentifier(platform, '1.2.0-beta.12'), oldName);
    assert.equal(publicPackageIdentifier(platform, '2.0.0-beta.0'), newName);
  }
});

test('identity resolution rejects malformed and unsupported versions', () => {
  for (const version of ['v2.0.0-beta.0', '02.0.0-beta.0', '3.0.0-beta.0', '', null]) {
    assert.throws(() => publicPackageIdentifier('apple', version));
  }
});

test('unreleased platforms do not acquire a major-two identity', () => {
  assert.equal(publicPackageIdentifier('windows', '1.1.0'), 'Bota.WindowsSdk');
  assert.equal(publicPackageIdentifier('electron', '1.1.0'), '@bota.dev/electron-sdk');
  for (const platform of ['windows', 'electron', 'linux', '__proto__', 'toString']) {
    assert.throws(() => publicPackageIdentifier(platform, '2.0.0-beta.0'));
  }
});
