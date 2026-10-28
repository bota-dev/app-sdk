import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyCocoaPodsConsumer } from './verify-cocoapods-consumer.mjs';

const repository = 'https://github.com/bota-dev/cocoapods-specs.git';
const name = 'BotaAppSDK';
const version = '2.0.0-beta.22';
const checksum = 'a'.repeat(64);
const fixture = () => {
  const expectedSpec = {
    name, version, module_name: name,
    source: { http: `https://github.com/bota-dev/app-sdk/releases/download/v${version}/${name}.cocoapods.zip`, sha256: checksum },
    source_files: `Sources/${name}/**/*.swift`,
    vendored_frameworks: 'Artifacts/BotaDeviceSDKCore.xcframework',
  };
  return {
    repository, version, expectedSpec, installedSpec: structuredClone(expectedSpec),
    expectedSpecChecksum: 'b'.repeat(40),
    lock: {
      PODS: [`${name} (${version})`],
      DEPENDENCIES: [`${name} (= ${version})`],
      'SPEC REPOS': { [repository]: [name], trunk: ['OtherPod'] },
      'SPEC CHECKSUMS': { [name]: 'b'.repeat(40) },
      COCOAPODS: '1.16.2',
    },
  };
};

test('admits the exact named/versioned SDK only from the selected Specs repository', () => {
  assert.deepEqual(verifyCocoaPodsConsumer(fixture()), {
    name, version, repository, artifactUrl: fixture().expectedSpec.source.http,
    artifactSha256: checksum, cocoapodsVersion: '1.16.2',
  });
});

test('refuses successful installation from Trunk, another repository or ambiguous sources', () => {
  for (const repos of [
    { trunk: [name] },
    { 'https://example.invalid/Specs.git': [name] },
    { [repository]: ['OtherPod'], trunk: [name] },
    { [repository]: [name], trunk: [name] },
    { [repository]: [name, name] },
  ]) {
    const input = fixture();
    input.lock['SPEC REPOS'] = repos;
    assert.throws(() => verifyCocoaPodsConsumer(input), /Specs repository/);
  }
});

test('refuses local, podspec and Git overrides while allowing unrelated Flutter plugin paths', () => {
  for (const section of ['EXTERNAL SOURCES', 'CHECKOUT OPTIONS']) {
    for (const source of [{ ':path': '../sdk' }, { ':podspec': '../sdk.podspec' }, { ':git': repository }]) {
      const input = fixture();
      input.lock[section] = { [name]: source };
      assert.throws(() => verifyCocoaPodsConsumer(input), /external override/);
    }
  }
  const input = fixture();
  input.lock['EXTERNAL SOURCES'] = { bota_app_sdk: { ':path': '.symlinks/plugins/bota_app_sdk/ios' } };
  assert.equal(verifyCocoaPodsConsumer(input).version, version);
});

test('refuses wrong or multiply resolved versions and an unpinned native dependency', () => {
  for (const entries of [
    [`${name} (2.0.0-beta.2)`],
    [`${name} (${version})`, `${name}/Other (2.0.0-beta.2)`],
    [],
  ]) {
    const input = fixture();
    input.lock.PODS = entries;
    assert.throws(() => verifyCocoaPodsConsumer(input), /resolved SDK/);
  }
  for (const dependency of [name, `${name} (>= ${version})`, `${name} (= 2.0.0-beta.2)`]) {
    const input = fixture();
    input.lock.DEPENDENCIES = [dependency];
    assert.throws(() => verifyCocoaPodsConsumer(input), /exact native dependency/);
  }
});

test('refuses substituted installed metadata and archive identities or checksums', () => {
  for (const change of [
    spec => { spec.name = 'OtherPod'; },
    spec => { spec.version = '2.0.0-beta.2'; },
    spec => { spec.source.http = 'https://example.invalid/other.zip'; },
    spec => { spec.source.sha256 = 'c'.repeat(64); },
    spec => { spec.source_files = 'Other/**/*.swift'; },
  ]) {
    const input = fixture();
    change(input.installedSpec);
    assert.throws(() => verifyCocoaPodsConsumer(input), /installed Podspec/);
  }
  for (const source of [
    { http: 'https://example.invalid/other.zip', sha256: checksum },
    { http: fixture().expectedSpec.source.http, sha256: '0'.repeat(64) },
    { git: repository, tag: version },
  ]) {
    const input = fixture();
    input.expectedSpec.source = source;
    input.installedSpec.source = structuredClone(source);
    assert.throws(() => verifyCocoaPodsConsumer(input), /archive identity/);
  }
});

test('supports preserved historical package identities and dependency-bearing lock entries', () => {
  const input = fixture();
  input.version = '1.2.0-beta.11';
  input.expectedSpec.name = input.installedSpec.name = 'BotaAppleSDK';
  input.expectedSpec.version = input.installedSpec.version = input.version;
  const source = { http: `https://github.com/bota-dev/app-sdk/releases/download/v${input.version}/BotaAppleSDK.cocoapods.zip`, sha256: checksum };
  input.expectedSpec.source = source;
  input.installedSpec = structuredClone(input.expectedSpec);
  input.lock.PODS = [{ [`BotaAppleSDK (${input.version})`]: ['OtherPod'] }];
  input.lock.DEPENDENCIES = [`BotaAppleSDK (= ${input.version})`];
  input.lock['SPEC REPOS'] = { [repository]: ['BotaAppleSDK'] };
  input.lock['SPEC CHECKSUMS'] = { BotaAppleSDK: 'b'.repeat(40) };
  assert.equal(verifyCocoaPodsConsumer(input).name, 'BotaAppleSDK');
});

test('refuses incomplete lock metadata and a different CocoaPods client', () => {
  for (const change of [
    lock => { delete lock['SPEC REPOS']; },
    lock => { delete lock['SPEC CHECKSUMS']; },
    lock => { lock['SPEC CHECKSUMS'][name] = ''; },
    lock => { lock['SPEC CHECKSUMS'][name] = 'c'.repeat(40); },
    lock => { lock.COCOAPODS = '1.17.0'; },
    lock => { lock.PODS = null; },
  ]) {
    const input = fixture();
    change(input.lock);
    assert.throws(() => verifyCocoaPodsConsumer(input));
  }
});

test('CLI refuses executable or unrelated installed Podspec inputs before invoking Ruby', () => {
  const helper = fileURLToPath(new URL('./verify-cocoapods-consumer.mjs', import.meta.url));
  for (const filename of ['BotaAppSDK.podspec', 'OtherPod.podspec.json']) {
    const result = spawnSync(process.execPath, [helper,
      '--version', version, '--lock', 'unused-lock', '--repos-root', 'unused-repositories',
      '--installed-spec', filename], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /installed Podspec must be the selected JSON metadata/);
  }
});
