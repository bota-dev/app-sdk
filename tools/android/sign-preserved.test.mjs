import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stagePreserved } from './sign-preserved.mjs';
import { primaryFiles } from './normalize-central-repository.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bota-sign-preserved-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = '2.0.0-beta.5';
  const names = primaryFiles('bota-app-sdk', version);
  for (const name of names) {
    await writeFile(join(root, name), name);
    await writeFile(join(root, `${name}.sha256`), createHash('sha256').update(name).digest('hex'));
  }
  return { root, version, names, raw: join(root, 'raw') };
}
test('signs each preserved primary file and stages the complete raw Maven inventory', async t => {
  const f = await fixture(t); const signed = [];
  await stagePreserved({ input: f.root, output: f.raw, version: f.version,
    sign: async bytes => { signed.push(bytes.toString()); return Buffer.from(`signature:${bytes}`); } });
  assert.deepEqual(signed, f.names);
  for (const name of f.names) {
    const path = join(f.raw, 'dev/bota/bota-app-sdk', f.version, name);
    assert.equal(await readFile(path, 'utf8'), name);
    assert.equal(await readFile(`${path}.asc`, 'utf8'), `signature:${name}`);
    for (const algorithm of ['md5', 'sha1', 'sha256', 'sha512']) {
      assert.equal(await readFile(`${path}.${algorithm}`, 'utf8'), createHash(algorithm).update(name).digest('hex'));
    }
  }
});
test('refuses changed input bytes before signing any file', async t => {
  const f = await fixture(t); let calls = 0;
  await writeFile(join(f.root, f.names[4]), 'drift');
  await assert.rejects(stagePreserved({ input: f.root, output: f.raw, version: f.version,
    sign: async () => { calls++; return Buffer.from('sig'); } }), /checksum/);
  assert.equal(calls, 0);
});
test('refuses unsafe versions and existing output instead of replacing signed inputs', async t => {
  const f = await fixture(t);
  await assert.rejects(stagePreserved({ input: f.root, output: f.raw, version: '../escape', sign: async () => {} }), /version/);
  const options = { input: f.root, output: f.raw, version: f.version, sign: async () => Buffer.from('sig') };
  await stagePreserved(options);
  await assert.rejects(stagePreserved(options), /EEXIST/);
});
