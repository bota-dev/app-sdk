import assert from 'node:assert/strict';
import test from 'node:test';
import { supportsGeneratedRuntime } from './runtime-release-support.mjs';

test('historical releases retain recovery without the newly introduced runtime export', () => {
  for (const version of ['1.1.0', '1.2.0-beta.12', '2.0.0-beta.0', '2.0.0-beta.15']) {
    assert.equal(supportsGeneratedRuntime(version), false, version);
  }
  for (const version of ['2.0.0-beta.16', '2.0.0-beta.17', '2.0.1-beta.0', '2.1.0-beta.0', '2.0.0', '2.1.0']) {
    assert.equal(supportsGeneratedRuntime(version), true, version);
  }
});

test('malformed release identities fail rather than bypass the public runtime check', () => {
  for (const version of ['', 'v2.0.0-beta.16', '2.0.0-beta.016', '2.0.0-beta.16;echo', '2.0.0-beta.9007199254740992']) {
    assert.throws(() => supportsGeneratedRuntime(version), undefined, version);
  }
});
