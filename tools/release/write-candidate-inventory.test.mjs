import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const sourceRevision = 'a'.repeat(40);

test('writes a deterministic sorted inventory for both native release directories', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bota-candidate-inventory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const apple = join(directory, 'apple-release');
  const android = join(directory, 'android-release');
  const output = join(directory, 'release-candidate-files.json');
  await mkdir(apple);
  await mkdir(android);
  await writeFile(join(apple, 'z.txt'), 'apple');
  await writeFile(join(android, 'a.txt'), 'android');

  const arguments_ = ['--source-revision', sourceRevision, '--output', output, apple, android];
  await execute('tools/release/write-candidate-inventory.sh', arguments_, { cwd: process.cwd() });
  const first = await readFile(output, 'utf8');
  const inventory = JSON.parse(first);

  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.sourceRevision, sourceRevision);
  assert.deepEqual(inventory.files.map((file) => file.path), [
    'android-release/a.txt',
    'apple-release/z.txt',
  ]);
  assert.deepEqual(inventory.files.map((file) => file.byteLength), [7, 5]);
  assert.ok(inventory.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)));

  await execute('tools/release/write-candidate-inventory.sh', arguments_, { cwd: process.cwd() });
  assert.equal(await readFile(output, 'utf8'), first);
});
