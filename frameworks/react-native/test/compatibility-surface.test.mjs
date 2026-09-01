import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractReactNativeApi } from '../../../tools/baseline/react-native-api-contract.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(packageRoot, '../..');
const baseline = JSON.parse(
  readFileSync(
    resolve(
      workspaceRoot,
      'protocol/baseline/react-native-public-api-0.0.65.json'
    ),
    'utf8'
  )
);
const deferredWorkflowClasses = new Set([
  'BotaClient',
]);

const normalizeLiteralUnionOrder = (value) => {
  if (Array.isArray(value)) return value.map(normalizeLiteralUnionOrder);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        normalizeLiteralUnionOrder(child),
      ])
    );
  }
  if (
    typeof value === 'string' &&
    /^"[^"]+"(?: \| "[^"]+")+$/.test(value)
  ) {
    return value.split(' | ').sort().join(' | ');
  }
  return value;
};

test('pure compatibility exports match the frozen 0.0.65 surface', () => {
  const actualByName = new Map(
    extractReactNativeApi(packageRoot).exports.map((entry) => [entry.name, entry])
  );
  const expected = baseline.surface.exports.filter(
    (entry) => !deferredWorkflowClasses.has(entry.name)
  );

  for (const entry of expected) {
    assert.deepEqual(
      normalizeLiteralUnionOrder(actualByName.get(entry.name)),
      normalizeLiteralUnionOrder(entry),
      entry.name
    );
  }
});
