import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('committed Codegen contract matches pinned iOS and Android output', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/verify-codegen.mjs'],
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' }
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /Codegen contract verified/);
});
