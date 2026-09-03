import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parseReleaseRef,
  resolveReleaseChannel,
  run,
} from './resolve-release-channel.mjs';

const testPolicy = {
  schemaVersion: 1,
  appSdkChannel: 'beta',
  npmDistTag: 'beta',
  githubPrerelease: true,
  requirePrereleaseForNewTags: true,
};

test('new App SDK releases resolve to beta and GitHub prerelease', () => {
  assert.deepEqual(
    resolveReleaseChannel({
      ref: 'refs/tags/v1.2.0-beta.0',
      mode: 'new',
      policy: testPolicy,
    }),
    { version: '1.2.0-beta.0', npmTag: 'beta', githubPrerelease: true },
  );
});

test('new stable App SDK tags are rejected while beta policy is active', () => {
  assert.throws(
    () =>
      resolveReleaseChannel({
        ref: 'refs/tags/v1.2.0',
        mode: 'new',
        policy: testPolicy,
      }),
    /must contain a prerelease component/,
  );
});

test('build metadata is not mistaken for a prerelease component', () => {
  assert.throws(
    () =>
      resolveReleaseChannel({
        ref: 'refs/tags/v1.2.0+build-1',
        mode: 'new',
        policy: testPolicy,
      }),
    /must contain a prerelease component/,
  );
});

test('historical stable release recovery remains possible', () => {
  assert.deepEqual(
    resolveReleaseChannel({
      ref: 'refs/tags/v1.1.0',
      mode: 'recovery',
      policy: testPolicy,
    }),
    { version: '1.1.0', npmTag: 'beta', githubPrerelease: true },
  );
});

test('only exact release tag refs are accepted', () => {
  assert.equal(parseReleaseRef('v1.2.0-beta.0'), '1.2.0-beta.0');
  assert.throws(() => parseReleaseRef('refs/heads/main'), /release tag/);
  assert.throws(() => parseReleaseRef('v01.2.0-beta.0'), /semantic version/);
});

test('unsupported channel policies are rejected', () => {
  assert.throws(
    () =>
      resolveReleaseChannel({
        ref: 'v1.2.0-beta.0',
        mode: 'new',
        policy: { ...testPolicy, npmDistTag: 'latest' },
      }),
    /unsupported release channel policy/,
  );
});

test('CLI writes stable GitHub output names', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bota-release-channel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'github-output');

  await run([
    '--ref',
    'refs/tags/v1.2.0-beta.0',
    '--mode',
    'new',
    '--github-output',
    output,
  ]);

  assert.equal(
    await readFile(output, 'utf8'),
    'version=1.2.0-beta.0\nnpm_tag=beta\ngithub_prerelease=true\n',
  );
});
