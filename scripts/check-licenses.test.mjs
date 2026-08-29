import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const run = (fixture) =>
  spawnSync(
    process.execPath,
    ['scripts/check-licenses.mjs', '--report', `scripts/__fixtures__/${fixture}`],
    { cwd: process.cwd(), encoding: 'utf8' }
  );

test('rejects a dependency whose only license is forbidden', () => {
  const result = run('forbidden.json');
  const output = `${result.stdout}${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /forbidden-package@1\.0\.0/);
  assert.match(output, /GPL-3\.0-only/);
});

test('accepts a dual license with a permissive option', () => {
  const result = run('permissive-dual.json');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no forbidden licenses/);
});
