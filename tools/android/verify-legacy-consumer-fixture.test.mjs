import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('freezes the legacy consumer with the Kotlin 2.1 metadata floor', () => {
  const output = execFileSync('tools/android/verify-legacy-consumer-fixture.sh', {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.match(output, /kotlinMetadata=2\.1\.0/);
});
