import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { normalizeCentralRepository } from './normalize-central-repository.mjs';
import { coordinate, createRawRepository, listFiles, mavenPom, version } from './release-test-helpers.mjs';

async function fixture(overrides) {
  const directory = await mkdtemp(join(tmpdir(), 'bota-central-normalize-'));
  const targetRoot = join(directory, 'target');
  const rawRepository = join(targetRoot, 'android-central-raw');
  const portalRepository = join(targetRoot, 'android-central-portal');
  const raw = await createRawRepository(rawRepository, overrides);
  return { directory, targetRoot, rawRepository, portalRepository, raw };
}

test('normalizes the exact 55-file Gradle repository into the canonical 30-file Portal tree', async (t) => {
  const value = await fixture();
  t.after(() => rm(value.directory, { recursive: true, force: true }));

  const result = await normalizeCentralRepository({
    rawRepository: value.rawRepository,
    portalRepository: value.portalRepository,
    targetRoot: value.targetRoot,
    coordinate,
    version,
  });

  assert.equal((await listFiles(value.rawRepository)).length, 55);
  const portalFiles = await listFiles(value.portalRepository);
  assert.equal(portalFiles.length, 30);
  assert.equal(result.files.length, 30);
  assert.ok(portalFiles.every((path) => !path.includes('maven-metadata')));
  assert.ok(portalFiles.every((path) => !/\.asc\.(md5|sha1|sha256|sha512)$/.test(path)));
});

test('rejects corrupted checksums and unexpected raw repository files', async (t) => {
  const corrupt = await fixture();
  const extra = await fixture();
  t.after(() => Promise.all([
    rm(corrupt.directory, { recursive: true, force: true }),
    rm(extra.directory, { recursive: true, force: true }),
  ]));

  const aar = `bota-android-sdk-${version}.aar`;
  await writeFile(join(corrupt.raw.versionDirectory, `${aar}.sha256`), '0'.repeat(64));
  await assert.rejects(() => normalizeCentralRepository({
    rawRepository: corrupt.rawRepository,
    portalRepository: corrupt.portalRepository,
    targetRoot: corrupt.targetRoot,
    coordinate,
    version,
  }), /checksum/i);

  await writeFile(join(extra.rawRepository, 'unexpected.txt'), 'unexpected');
  await assert.rejects(() => normalizeCentralRepository({
    rawRepository: extra.rawRepository,
    portalRepository: extra.portalRepository,
    targetRoot: extra.targetRoot,
    coordinate,
    version,
  }), /unexpected/i);
});

test('rejects wrong coordinates, dynamic dependencies, and destinations outside target', async (t) => {
  const wrong = await fixture({ pom: mavenPom().replace('<groupId>dev.bota</groupId>', '<groupId>dev.other</groupId>') });
  const dynamic = await fixture({ pom: mavenPom().replace('<version>4.12.0</version>', '<version>4.+</version>') });
  t.after(() => Promise.all([
    rm(wrong.directory, { recursive: true, force: true }),
    rm(dynamic.directory, { recursive: true, force: true }),
  ]));

  await assert.rejects(() => normalizeCentralRepository({
    rawRepository: wrong.rawRepository,
    portalRepository: wrong.portalRepository,
    targetRoot: wrong.targetRoot,
    coordinate,
    version,
  }), /POM|coordinate/i);

  await assert.rejects(() => normalizeCentralRepository({
    rawRepository: dynamic.rawRepository,
    portalRepository: dynamic.portalRepository,
    targetRoot: dynamic.targetRoot,
    coordinate,
    version,
  }), /static|dynamic/i);

  await assert.rejects(() => normalizeCentralRepository({
    rawRepository: dynamic.rawRepository,
    portalRepository: join(dynamic.directory, 'outside'),
    targetRoot: dynamic.targetRoot,
    coordinate,
    version,
  }), /target/i);
  await assert.rejects(() => normalizeCentralRepository({
    rawRepository: dynamic.rawRepository,
    portalRepository: dynamic.portalRepository,
    targetRoot: dynamic.targetRoot,
    coordinate: '../bota-android-sdk',
    version,
  }), /coordinate/i);
});
