import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { verifyNativeBaselines } from './verify-native-baselines.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(directory, ...args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
}

function createRepository(label) {
  const directory = mkdtempSync(join(tmpdir(), `bota-${label}-`));
  temporaryDirectories.push(directory);
  git(directory, 'init', '--quiet');
  git(directory, 'config', 'user.email', 'tests@bota.dev');
  git(directory, 'config', 'user.name', 'Bota Tests');
  writeFileSync(join(directory, 'README.md'), `${label}\n`);
  git(directory, 'add', 'README.md');
  git(directory, 'commit', '--quiet', '-m', 'initial');
  return { directory, revision: git(directory, 'rev-parse', 'HEAD') };
}

function manifestFor(appleRevision, androidRevision) {
  return {
    schemaVersion: 1,
    platforms: {
      apple: { revision: appleRevision },
      android: { revision: androidRevision },
    },
  };
}

test('accepts clean native checkouts at the pinned revisions', () => {
  const apple = createRepository('apple');
  const android = createRepository('android');

  const result = verifyNativeBaselines({
    manifest: manifestFor(apple.revision, android.revision),
    applePath: apple.directory,
    androidPath: android.directory,
  });

  assert.deepEqual(result, {
    apple: { revision: apple.revision, dirtyPaths: [] },
    android: { revision: android.revision, dirtyPaths: [] },
  });
});

test('rejects a dirty native checkout', () => {
  const apple = createRepository('apple');
  const android = createRepository('android');
  writeFileSync(join(apple.directory, 'README.md'), 'changed\n');

  assert.throws(
    () =>
      verifyNativeBaselines({
        manifest: manifestFor(apple.revision, android.revision),
        applePath: apple.directory,
        androidPath: android.directory,
      }),
    /Apple baseline is dirty: M README\.md/,
  );
});

test('allows only explicitly audited dirty documentation paths', () => {
  const apple = createRepository('apple');
  const android = createRepository('android');
  writeFileSync(join(apple.directory, 'AGENTS.md'), 'local context\n');

  const result = verifyNativeBaselines({
    manifest: manifestFor(apple.revision, android.revision),
    applePath: apple.directory,
    androidPath: android.directory,
    allowDirtyPaths: ['AGENTS.md'],
  });

  assert.deepEqual(result.apple.dirtyPaths, ['AGENTS.md']);
});

test('rejects a revision mismatch', () => {
  const apple = createRepository('apple');
  const android = createRepository('android');

  assert.throws(
    () =>
      verifyNativeBaselines({
        manifest: manifestFor(apple.revision, '0'.repeat(40)),
        applePath: apple.directory,
        androidPath: android.directory,
      }),
    new RegExp(`Android revision ${android.revision} does not match ${'0'.repeat(40)}`),
  );
});
