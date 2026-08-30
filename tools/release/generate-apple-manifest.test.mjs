import assert from 'node:assert/strict';
import test from 'node:test';

import { generateAppleManifest } from './generate-apple-manifest.mjs';

const checksum = 'c'.repeat(64);
const sourceRevision = 'd'.repeat(40);
const fixtureDigest = 'e'.repeat(64);
const firmwareRevision = 'f'.repeat(40);

test('Apple manifest uses synchronized release evidence and supported capabilities only', () => {
  const manifest = generateAppleManifest({
    sdkVersion: '1.0.0-alpha.1',
    sourceRevision,
    artifactChecksum: checksum,
    baseline: { fixtureDigest },
    compatibility: {
      sdkVersion: '1.0.0-alpha.1',
      firmwareBaseline: { version: '1.0.17', revision: firmwareRevision },
      features: [
        { feature: 'device_status', earliestKnownFirmware: '1.0.17', status: 'supported' },
        { feature: 'wifi_configuration', earliestKnownFirmware: '1.0.17', status: 'partial' },
      ],
      workflows: [
        { workflow: 'connection', status: 'supported' },
        { workflow: 'future-workflow', status: 'partial' },
      ],
    },
  });

  assert.equal(manifest.sdkVersion, '1.0.0-alpha.1');
  assert.equal(manifest.sourceRevision, sourceRevision);
  assert.equal(manifest.protocolFixtureDigest, fixtureDigest);
  assert.deepEqual(manifest.firmwareCompatibility, {
    minimum: '1.0.17',
    maximum: '1.0.17',
    baselineRevision: firmwareRevision,
  });
  assert.equal(manifest.artifacts[0].ecosystem, 'swiftpm');
  assert.equal(manifest.artifacts[0].version, '1.0.0-alpha.1');
  assert.equal(manifest.artifacts[0].checksumSha256, checksum);
  assert.deepEqual(manifest.artifacts[0].capabilities, ['device_status', 'workflow_connection']);
  assert.equal(new Set(manifest.artifacts[0].capabilities).size, manifest.artifacts[0].capabilities.length);
});

test('Apple manifest rejects drift, zero checksums, and duplicate supported capabilities', () => {
  const input = {
    sdkVersion: '1.0.0-alpha.1',
    sourceRevision,
    artifactChecksum: checksum,
    baseline: { fixtureDigest },
    compatibility: {
      sdkVersion: '1.0.0-alpha.1',
      firmwareBaseline: { version: '1.0.17', revision: firmwareRevision },
      features: [{ feature: 'device_status', earliestKnownFirmware: '1.0.17', status: 'supported' }],
      workflows: [],
    },
  };
  assert.throws(() => generateAppleManifest({
    ...input,
    compatibility: { ...input.compatibility, sdkVersion: '1.0.0-alpha.2' },
  }));
  assert.throws(() => generateAppleManifest({ ...input, artifactChecksum: '0'.repeat(64) }));
  assert.throws(() => generateAppleManifest({
    ...input,
    compatibility: {
      ...input.compatibility,
      features: [...input.compatibility.features, ...input.compatibility.features],
    },
  }));
});
