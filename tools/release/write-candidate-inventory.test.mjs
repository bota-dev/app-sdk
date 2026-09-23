import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const sourceRevision = 'a'.repeat(40);

test('writes a deterministic sorted inventory for every synchronized facade candidate', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bota-candidate-inventory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const apple = join(directory, 'apple-release');
  const android = join(directory, 'android-release');
  const flutter = join(directory, 'flutter-release');
  const reactNative = join(directory, 'react-native-release');
  const output = join(directory, 'release-candidate-files.json');
  await mkdir(apple);
  await mkdir(android);
  await mkdir(flutter);
  await mkdir(reactNative);
  await writeFile(join(apple, 'z.txt'), 'apple');
  await writeFile(join(android, 'a.txt'), 'android');
  await writeFile(join(flutter, 'm.txt'), 'flutter');
  await writeFile(join(reactNative, 'n.txt'), 'react-native');

  const arguments_ = [
    '--source-revision', sourceRevision,
    '--output', output,
    apple, android, flutter, reactNative,
  ];
  await execute('tools/release/write-candidate-inventory.sh', arguments_, { cwd: process.cwd() });
  const first = await readFile(output, 'utf8');
  const inventory = JSON.parse(first);

  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.sourceRevision, sourceRevision);
  assert.deepEqual(inventory.files.map((file) => file.path), [
    'android-release/a.txt',
    'apple-release/z.txt',
    'flutter-release/m.txt',
    'react-native-release/n.txt',
  ]);
  assert.deepEqual(inventory.files.map((file) => file.byteLength), [7, 5, 7, 12]);
  assert.ok(inventory.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)));

  await execute('tools/release/write-candidate-inventory.sh', arguments_, { cwd: process.cwd() });
  assert.equal(await readFile(output, 'utf8'), first);
});

test('release workflow projections preserve the inventory schema', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bota-release-projection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'release-candidate-files.json');
  await writeFile(input, JSON.stringify({
    schemaVersion: 1,
    sourceRevision,
    files: [
      { path: 'apple-release/a.txt', byteLength: 1, sha256: 'a'.repeat(64) },
      { path: 'flutter-release/b.txt', byteLength: 1, sha256: 'b'.repeat(64) },
    ],
  }));
  const workflow = await readFile('.github/workflows/release.yml', 'utf8');
  const projections = [...workflow.matchAll(/EXPECTED_(?:NATIVE|FLUTTER)="\$\(jq -S -c \\\n\s+'([^']+)'/g)];
  assert.equal(projections.length, 3);

  for (const [, expression] of projections) {
    const { stdout } = await execute('jq', ['-S', '-c', expression, input]);
    const projected = JSON.parse(stdout);
    assert.equal(projected.schemaVersion, 1);
    assert.equal(projected.sourceRevision, sourceRevision);
    assert.equal(projected.files.length, 1);
  }
});
