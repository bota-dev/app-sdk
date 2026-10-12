import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('committed Codegen contract matches pinned iOS and Android output', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/verify-codegen.mjs'],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /Codegen contract verified/);
});
