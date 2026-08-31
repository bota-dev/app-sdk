import assert from 'node:assert/strict';
import test from 'node:test';

import { generateAppleManifest } from './generate-apple-manifest.mjs';
import { generateNativeManifest } from './generate-native-manifest.mjs';

const checksum = 'c'.repeat(64);
const sourceRevision = 'd'.repeat(40);
const fixtureDigest = 'e'.repeat(64);
const firmwareRevision = 'f'.repeat(40);
const compatibility = {
  sdkVersion: '1.0.2',
  firmwareBaseline: { version: '1.0.17', revision: firmwareRevision },
  features: [{ feature: 'device_status', earliestKnownFirmware: '1.0.17', status: 'supported' }],
  workflows: [{ workflow: 'connection', status: 'supported' }],
};

test('native manifest includes only supplied Apple and reviewed Android packages', () => {
  const manifest = generateNativeManifest({
    sdkVersion: '1.0.2',
    sourceRevision,
    baseline: { fixtureDigest },
    compatibility,
    artifacts: [
      {
        platform: 'apple',
        packageIdentifier: 'BotaAppleSDK',
        name: 'BotaDeviceSDKCore.xcframework.zip',
        ecosystem: 'swiftpm',
        version: '1.0.2',
        checksumSha256: checksum,
        capabilities: ['device_status'],
      },
      {
        platform: 'android',
        packageIdentifier: 'dev.bota:bota-android-sdk',
        name: 'bota-android-sdk-1.0.2.aar',
        ecosystem: 'maven',
        version: '1.0.2',
        checksumSha256: 'a'.repeat(64),
        capabilities: ['android_device_sdk'],
        capabilityEvidence: { reviewed: true, path: 'release/evidence/1.1.0-android-facade.md' },
      },
    ],
  });

  assert.equal(manifest.manifestVersion, 2);
  assert.deepEqual(manifest.artifacts.map((entry) => entry.platform), ['apple', 'android']);
  const android = manifest.artifacts[1];
  assert.equal(android.platform, 'android');
  assert.equal(android.packageIdentifier, 'dev.bota:bota-android-sdk');
  assert.equal(android.ecosystem, 'maven');
  assert.equal(android.version, '1.0.2');
  assert.match(android.name, /^bota-android-sdk-.+\.aar$/);
  assert.deepEqual(android.capabilities, ['android_device_sdk']);
  assert.equal('capabilityEvidence' in android, false);
});

test('native manifest rejects unreviewed Android capabilities and version or revision drift', () => {
  const base = {
    sdkVersion: '1.0.2',
    sourceRevision,
    baseline: { fixtureDigest },
    compatibility,
  };
  const android = {
    platform: 'android', packageIdentifier: 'dev.bota:bota-android-sdk',
    name: 'bota-android-sdk-1.0.2.aar', ecosystem: 'maven', version: '1.0.2',
    checksumSha256: checksum, capabilities: ['device_status'],
  };
  assert.throws(() => generateNativeManifest({ ...base, artifacts: [android] }), /reviewed evidence/i);
  assert.throws(() => generateNativeManifest({ ...base, artifacts: [{ ...android, version: '1.0.1', capabilityEvidence: { reviewed: true, path: 'release/evidence/x.md' } }] }), /version/i);
  assert.throws(() => generateNativeManifest({ ...base, sourceRevision: 'short', artifacts: [] }), /revision/i);
});

test('Apple compatibility wrapper preserves the current manifest contract', () => {
  const manifest = generateAppleManifest({
    sdkVersion: '1.0.2', sourceRevision, artifactChecksum: checksum,
    baseline: { fixtureDigest }, compatibility,
  });
  assert.equal(manifest.artifacts.length, 1);
  assert.equal(manifest.artifacts[0].platform, 'apple');
  assert.deepEqual(manifest.artifacts[0].capabilities, ['device_status', 'workflow_connection']);
});
