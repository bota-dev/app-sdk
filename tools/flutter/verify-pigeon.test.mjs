import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { generatedPigeonFiles, verifyPigeon } from './verify-pigeon.mjs';
import { normalizePigeonOutput } from './normalize-pigeon-output.mjs';

const workspaceRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const copyGeneratedTree = () => {
  const root = mkdtempSync(join(tmpdir(), 'bota-pigeon-drift-'));
  for (const file of generatedPigeonFiles) {
    const destination = join(root, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(workspaceRoot, file), destination);
  }
  return root;
};

const copyCanonicalOutputs = async (outputRoot) => {
  for (const file of generatedPigeonFiles) {
    const destination = join(outputRoot, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(workspaceRoot, file), destination);
  }
};

test('accepts byte-identical checked-in Pigeon outputs', async () => {
  const root = copyGeneratedTree();

  await assert.doesNotReject(
    verifyPigeon(root, { generate: copyCanonicalOutputs }),
  );
});

test('rejects one changed generated token', async () => {
  const root = copyGeneratedTree();
  const dartOutput = join(root, generatedPigeonFiles[0]);
  const source = readFileSync(dartOutput, 'utf8');
  assert.match(source, /BotaHostApi/);
  writeFileSync(dartOutput, source.replace('BotaHostApi', 'BotaHostApiDrift'));

  await assert.rejects(
    verifyPigeon(root, { generate: copyCanonicalOutputs }),
    /generated Pigeon output drift.*bota_api\.g\.dart/s,
  );
});

test('checked-in generated outputs contain no trailing whitespace', () => {
  for (const file of generatedPigeonFiles) {
    const source = readFileSync(join(workspaceRoot, file), 'utf8');
    assert.doesNotMatch(source, /[ \t]+$/m, file);
  }
});

test('normalization removes generated trailing whitespace only', () => {
  assert.equal(
    normalizePigeonOutput('sealed class Example \nval value = "a  "  \n'),
    'sealed class Example\nval value = "a  "\n',
  );
});
