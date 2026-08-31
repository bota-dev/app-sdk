import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildCentralBundle, inspectZip, verifyCentralBundle } from './build-central-bundle.mjs';
import { normalizeCentralRepository } from './normalize-central-repository.mjs';
import { coordinate, createRawRepository, version } from './release-test-helpers.mjs';

const sourceRevision = 'a'.repeat(40);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bota-central-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const targetRoot = join(directory, 'target');
  const rawRepository = join(targetRoot, 'android-central-raw');
  const repository = join(targetRoot, 'android-central-portal');
  await createRawRepository(rawRepository);
  await normalizeCentralRepository({ rawRepository, portalRepository: repository, targetRoot, coordinate, version });
  return {
    directory,
    repository,
    inventory: join(directory, 'central-bundle-files.json'),
    zip: join(directory, 'central-bundle.zip'),
  };
}

test('builds a byte-identical 30-entry Portal ZIP from a separate complete inventory', async (t) => {
  const value = await fixture(t);
  await buildCentralBundle({ ...value, coordinate, version, sourceRevision });
  const first = await readFile(value.zip);
  const manifest = JSON.parse(await readFile(value.inventory, 'utf8'));
  const entries = await inspectZip(value.zip);

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.files.length, 30);
  assert.deepEqual(manifest.files.map((entry) => entry.path), [...manifest.files.map((entry) => entry.path)].sort());
  assert.deepEqual(entries.map((entry) => entry.path), manifest.files.map((entry) => entry.path));
  assert.ok(entries.every((entry) => entry.mode === 0o644));
  assert.ok(entries.every((entry) => entry.timestamp === '1980-01-01T00:00:00.000Z'));
  assert.ok(entries.every((entry) => entry.extraFieldLength === 0));
  assert.ok(entries.every((entry) => !entry.directory));

  await buildCentralBundle({ ...value, coordinate, version, sourceRevision });
  assert.deepEqual(await readFile(value.zip), first);
  await verifyCentralBundle({ repository: value.repository, inventory: value.inventory, zip: value.zip });
});

test('rejects Portal byte drift, traversal, and an unrecorded ZIP entry', async (t) => {
  const value = await fixture(t);
  await buildCentralBundle({ ...value, coordinate, version, sourceRevision });
  const manifest = JSON.parse(await readFile(value.inventory, 'utf8'));
  await writeFile(join(value.repository, manifest.files[0].path), 'changed');
  await assert.rejects(() => verifyCentralBundle({ repository: value.repository, inventory: value.inventory, zip: value.zip }), /digest|length/i);

  manifest.files[0].path = '../escape';
  await writeFile(value.inventory, JSON.stringify(manifest));
  await assert.rejects(() => verifyCentralBundle({ repository: value.repository, inventory: value.inventory, zip: value.zip }), /path|traversal/i);

  await writeFile(value.zip, Buffer.concat([await readFile(value.zip), Buffer.from('unrecorded')]));
  await assert.rejects(() => verifyCentralBundle({ repository: value.repository, inventory: value.inventory, zip: value.zip }), /ZIP|inventory|trailing/i);
});

test('rejects duplicate ZIP entry names', async (t) => {
  const value = await fixture(t);
  await buildCentralBundle({ ...value, coordinate, version, sourceRevision });
  const bytes = await readFile(value.zip);
  const first = `dev/bota/bota-android-sdk/${version}/bota-android-sdk-${version}.aar.asc`;
  const second = `dev/bota/bota-android-sdk/${version}/bota-android-sdk-${version}.pom.asc`;
  assert.equal(Buffer.byteLength(first), Buffer.byteLength(second));
  const mutated = Buffer.from(bytes);
  let replacements = 0;
  for (let offset = 0; offset <= mutated.length - second.length; offset += 1) {
    if (mutated.subarray(offset, offset + second.length).toString('utf8') === second) {
      mutated.write(first, offset, 'utf8');
      replacements += 1;
    }
  }
  assert.equal(replacements, 2);
  await writeFile(value.zip, mutated);
  await assert.rejects(() => verifyCentralBundle({ repository: value.repository, inventory: value.inventory, zip: value.zip }), /duplicate/i);
});
