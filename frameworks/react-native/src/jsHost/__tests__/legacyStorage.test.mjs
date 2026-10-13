import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';

const { isEmptyLegacyAndroidV2CheckpointCatalog: isEmpty } = loadSource('legacyStorage.ts');
test('generated Rust admits only the exact empty legacy Android checkpoint catalog', () => {
  const empty = [0x42, 0x56, 0x32, 0x4c, 0, 0, 0, 1, 0, 0, 0, 0];
  assert.equal(isEmpty(empty), true);
  assert.equal(isEmpty(Uint8Array.from(empty)), true);
  for (let length = 0; length < empty.length; length++) assert.equal(isEmpty(empty.slice(0, length)), false);
  for (let index = 0; index < empty.length; index++) {
    const changed = [...empty]; changed[index] ^= 1;
    assert.equal(isEmpty(changed), false);
  }
  assert.equal(isEmpty([...empty, 0]), false);
  assert.throws(() => isEmpty([256]));
});
