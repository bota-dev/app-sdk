import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  extractReactNativeApi,
  validateCompatibleReactNativeSurface,
} from '../../../tools/baseline/react-native-api-contract.mjs';

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
const maintenance = JSON.parse(readFileSync(resolve(workspaceRoot,
  'protocol/baseline/react-native-maintenance-additions-0.0.67.json'), 'utf8'));

test('preserves all 80 frozen exports plus exact enumerated maintenance additions', () => {
  assert.equal(maintenance.frozenSurfaceDigest, baseline.surfaceDigest);
  assert.deepEqual(validateCompatibleReactNativeSurface({
    frozen: baseline.surface,
    surface: extractReactNativeApi(packageRoot),
    additions: maintenance.additions,
  }), []);
});
