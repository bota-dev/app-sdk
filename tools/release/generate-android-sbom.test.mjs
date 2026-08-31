import assert from 'node:assert/strict';
import test from 'node:test';

import { generateAndroidSbom } from './generate-android-sbom.mjs';

const checksum = 'a'.repeat(64);
const revision = 'b'.repeat(40);
const abis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
const nativePaths = abis.flatMap((abi) => [
  `jni/${abi}/libbota_android_jni.so`,
  `jni/${abi}/libbota_device_sdk_ffi.so`,
]);
const nativeEntries = nativePaths.map((path, index) => ({
  path,
  sha256: String(index + 1).padStart(64, '0'),
}));

function input() {
  return {
    sdkVersion: '1.0.2',
    sourceRevision: revision,
    artifactChecksum: checksum,
    createdAt: '2026-08-30T00:00:00Z',
    aarEntries: nativeEntries,
    cargoPackages: [
      { name: 'bota-device-sdk-core', version: '1.0.2', license: 'MIT' },
      { name: 'bota-device-sdk-ffi', version: '1.0.2', license: 'MIT', dependencies: ['bota-device-sdk-core'] },
    ],
    gradleDependencies: [
      { group: 'org.jetbrains.kotlinx', name: 'kotlinx-coroutines-android', version: '1.10.2', license: 'Apache-2.0' },
      { group: 'com.squareup.okhttp3', name: 'okhttp', version: '4.12.0', license: 'Apache-2.0' },
      { group: 'org.jetbrains.kotlin', name: 'kotlin-stdlib', version: '2.1.20', license: 'Apache-2.0' },
    ],
  };
}

test('Android SPDX records the facade, Rust crates, Gradle runtime graph, AAR, and all native ABI files', () => {
  const sbom = generateAndroidSbom(input());
  const serialized = JSON.stringify(sbom);

  assert.equal(sbom.spdxVersion, 'SPDX-2.3');
  assert.equal(sbom.name, 'BotaAndroidSDK-1.0.2');
  for (const name of ['BotaAndroidSDK', 'bota-device-sdk-core', 'bota-device-sdk-ffi', 'kotlinx-coroutines-android', 'okhttp', 'kotlin-stdlib']) {
    assert.ok(sbom.packages.some((entry) => entry.name === name), name);
  }
  assert.equal(sbom.files.find((entry) => entry.fileName.endsWith('.aar')).checksums[0].checksumValue, checksum);
  for (const path of nativePaths) assert.ok(sbom.files.some((entry) => entry.fileName === path), path);
  assert.ok(sbom.packages.every((entry) => ['MIT', 'Apache-2.0'].includes(entry.licenseDeclared)));
  assert.ok(!serialized.includes('/private/'));
  assert.ok(!serialized.includes('/Users/'));
});

test('Android SPDX rejects invalid checksums, missing native libraries, and incomplete ABI coverage', () => {
  assert.throws(() => generateAndroidSbom({ ...input(), artifactChecksum: '0'.repeat(64) }), /checksum/i);
  assert.throws(() => generateAndroidSbom({ ...input(), aarEntries: [] }), /native/i);
  assert.throws(() => generateAndroidSbom({ ...input(), aarEntries: nativeEntries.slice(0, -1) }), /x86_64|ABI/i);
});
