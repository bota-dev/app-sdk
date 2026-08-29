import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
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
