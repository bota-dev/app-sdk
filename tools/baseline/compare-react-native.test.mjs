import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  compareReactNative,
  evaluateFixtureCase,
  fixtureDigest,
  normalizeValue,
} from './compare-react-native.mjs';

test('normalizes dates and byte buffers for language-neutral comparison', () => {
  const value = {
    createdAt: new Date('2023-11-14T22:13:20.000Z'),
    payload: Buffer.from([0x00, 0xab, 0xff]),
    omitted: undefined,
  };

  assert.deepEqual(normalizeValue(value), {
    createdAt: '2023-11-14T22:13:20.000Z',
    payload: '00abff',
  });
});

test('fixture digest is deterministic', () => {
  const first = fixtureDigest('protocol/fixtures');
  const second = fixtureDigest('protocol/fixtures');

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);
});

test('evaluates a parser fixture against supplied SDK functions', () => {
  const fixtureCase = {
    operation: 'parseDeviceStatus',
    inputHex: '01',
    expected: { batteryLevel: 1 },
  };
  const sdk = {
    parsers: {
      parseDeviceStatus: (input) => ({ batteryLevel: input[0] }),
    },
  };

  assert.doesNotThrow(() => evaluateFixtureCase(fixtureCase, sdk));
});

test('public API verification runs before fixture execution', () => {
  const sdkPath = mkdtempSync(join(tmpdir(), 'bota-rn-comparator-'));
  try {
    writeFileSync(
      join(sdkPath, 'package.json'),
      '{"name":"@bota.dev/react-native-sdk","version":"0.0.65"}\n'
    );
    execFileSync('git', ['init'], { cwd: sdkPath });
    execFileSync('git', ['config', 'user.name', 'Bota Test'], { cwd: sdkPath });
    execFileSync('git', ['config', 'user.email', 'test@bota.dev'], { cwd: sdkPath });
    execFileSync('git', ['add', '.'], { cwd: sdkPath });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: sdkPath });
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: sdkPath,
      encoding: 'utf8',
    }).trim();
    let received;

    assert.throws(
      () =>
        compareReactNative({
          sdkPath,
          expectedCommit: revision,
          expectedVersion: '0.0.65',
          fixtures: 'does-not-exist',
          apiContract: 'protocol/baseline/react-native-public-api-0.0.65.json',
          apiContractVerifier: (options) => {
            received = options;
            throw new Error('public API drift');
          },
        }),
      /public API drift/
    );
    assert.deepEqual(received, {
      sdkPath,
      contract: 'protocol/baseline/react-native-public-api-0.0.65.json',
    });
  } finally {
    rmSync(sdkPath, { recursive: true, force: true });
  }
});
