import assert from 'node:assert/strict';
import test from 'node:test';

import { generateAppleSbom } from './generate-apple-sbom.mjs';

const checksum = 'a'.repeat(64);
const sourceRevision = 'b'.repeat(40);

test('Apple SPDX names the synchronized package and records the native dependency graph', () => {
  const sbom = generateAppleSbom({
    sdkVersion: '1.0.0-alpha.1',
    sourceRevision,
    artifactChecksum: checksum,
    createdAt: '2026-08-30T00:00:00Z',
    cargoMetadata: {
      packages: [
        {
          id: 'path+file:///private/build/core#bota-device-sdk-core@1.0.0-alpha.1',
          name: 'bota-device-sdk-core',
          version: '1.0.0-alpha.1',
          license: 'MIT',
          source: null,
        },
        {
          id: 'path+file:///private/build/ffi#bota-device-sdk-ffi@1.0.0-alpha.1',
          name: 'bota-device-sdk-ffi',
          version: '1.0.0-alpha.1',
          license: 'MIT',
          source: null,
        },
      ],
      resolve: {
        nodes: [
          {
            id: 'path+file:///private/build/core#bota-device-sdk-core@1.0.0-alpha.1',
            dependencies: [],
          },
          {
            id: 'path+file:///private/build/ffi#bota-device-sdk-ffi@1.0.0-alpha.1',
            dependencies: ['path+file:///private/build/core#bota-device-sdk-core@1.0.0-alpha.1'],
          },
        ],
      },
    },
    swiftDependencies: {
      identity: 'apple',
      name: 'BotaDeviceSDK',
      version: 'unspecified',
      path: '/private/build/platforms/apple',
      url: '/private/build/platforms/apple',
      dependencies: [],
    },
  });

  assert.equal(sbom.spdxVersion, 'SPDX-2.3');
  assert.equal(sbom.name, 'BotaDeviceSDK-1.0.0-alpha.1');
  assert.ok(sbom.packages.some((entry) => entry.name === 'BotaDeviceSDK'));
  const core = sbom.packages.find((entry) => entry.name === 'bota-device-sdk-core');
  const ffi = sbom.packages.find((entry) => entry.name === 'bota-device-sdk-ffi');
  assert.ok(sbom.relationships.some((entry) =>
    entry.spdxElementId === ffi.SPDXID
      && entry.relationshipType === 'DEPENDS_ON'
      && entry.relatedSpdxElement === core.SPDXID));
  assert.equal(sbom.files[0].checksums[0].checksumValue, checksum);
  assert.ok(!JSON.stringify(sbom).includes('/private/build'));
});

test('Apple SPDX rejects invalid checksums and source revisions', () => {
  const input = {
    sdkVersion: '1.0.0-alpha.1',
    sourceRevision,
    artifactChecksum: checksum,
    createdAt: '2026-08-30T00:00:00Z',
    cargoMetadata: { packages: [], resolve: { nodes: [] } },
    swiftDependencies: { identity: 'apple', name: 'BotaDeviceSDK', dependencies: [] },
  };
  assert.throws(() => generateAppleSbom({ ...input, artifactChecksum: '0'.repeat(64) }));
  assert.throws(() => generateAppleSbom({ ...input, sourceRevision: 'short' }));
});
