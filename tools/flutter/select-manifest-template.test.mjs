import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { selectManifestTemplate } from './select-manifest-template.mjs';
import { verifyReleaseManifestTemplate } from './verify-publication.mjs';

test('CI selects its checked candidate while release modes retain the release template', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flutter-template-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const version = '2.0.0-beta.20';
  const release = join(root, 'release/examples', `${version}.json`);
  assert.equal(selectManifestTemplate(root, version, '--ci'), release);
  mkdirSync(join(root, 'release/candidates'), { recursive: true });
  const candidate = join(root, 'release/candidates', `${version}.json`);
  writeFileSync(candidate, '{}');
  assert.equal(selectManifestTemplate(root, version, '--ci'), candidate);
  for (const mode of ['--check', '--write-example']) {
    assert.equal(selectManifestTemplate(root, version, mode), release);
  }
  assert.equal(selectManifestTemplate(root, '2.0.0-beta.21', '--ci'),
    join(root, 'release/examples/2.0.0-beta.21.json'));
  assert.throws(() => selectManifestTemplate(root, version, '--publish'), /Unknown/);
});

test('candidate templates still reject modified package bytes and archive hashes', () => {
  const template = {
    sourceRevision: 'a'.repeat(40),
    artifacts: [{
      platform: 'flutter', sourceRevision: 'a'.repeat(40),
      checksumSha256: 'b'.repeat(64),
      packageInventory: [{ path: 'lib/sdk.dart', sha256: 'c'.repeat(64) }],
    }],
  };
  verifyReleaseManifestTemplate(structuredClone(template), template);
  const changedFile = structuredClone(template);
  changedFile.artifacts[0].packageInventory[0].sha256 = 'd'.repeat(64);
  assert.throws(() => verifyReleaseManifestTemplate(changedFile, template), /does not match/);
  const changedArchive = structuredClone(template);
  changedArchive.artifacts[0].checksumSha256 = 'e'.repeat(64);
  assert.throws(() => verifyReleaseManifestTemplate(changedArchive, template), /does not match/);
});
