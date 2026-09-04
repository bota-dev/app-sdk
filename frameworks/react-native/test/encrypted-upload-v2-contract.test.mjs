import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = join(packageRoot, '..', '..');
const specPath = join(packageRoot, 'src/specs/NativeBotaDeviceSDK.ts');
const vectorPath = join(workspaceRoot, 'protocol/vectors/encrypted-upload-v2.json');
const digestPath = join(
  workspaceRoot,
  'core/device-sdk-core/src/generated/encrypted_upload_v2_vectors.rs'
);
const compatibilityPath = join(
  workspaceRoot,
  'protocol/compatibility/firmware-compatibility.json'
);

test('encrypted upload v2 is contract-only and absent from Codegen bytes', () => {
  const spec = readFileSync(specPath, 'utf8');
  for (const forbidden of [
    'ciphertext: Array',
    'manifest: Array',
    'authorization: Array',
    'receipt: Array',
    'ciphertextBase64',
    'manifestBase64',
    'authorizationBase64',
    'receiptBase64',
  ]) {
    assert.equal(spec.includes(forbidden), false, forbidden);
  }
  assert.equal(spec.includes('startEncryptedUploadV2'), false);
});

test('encrypted upload v2 vector digest matches generated Rust evidence', () => {
  const vectors = readFileSync(vectorPath);
  const actual = createHash('sha256').update(vectors).digest('hex');
  const generated = readFileSync(digestPath, 'utf8').match(
    /ENCRYPTED_UPLOAD_V2_VECTOR_SHA256[\s\S]*?"([0-9a-f]{64})"/
  );
  assert.ok(generated, 'generated Rust vector digest is missing');
  assert.equal(actual, generated[1]);
});

test('React Native runtime does not contain v2 transfer opcodes or characteristics', () => {
  const managers = join(packageRoot, 'src/managers');
  const runtimePaths = [
    join(packageRoot, 'src/ble/constants.ts'),
    ...readdirSync(managers)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(managers, name)),
  ];
  const source = runtimePaths.map((path) => readFileSync(path, 'utf8')).join('\n');

  assert.doesNotMatch(source, /ENCRYPTED_UPLOAD_V2_START|startEncryptedUploadV2/i);
  assert.doesNotMatch(
    source,
    /(?:encrypted.?upload.?v2.{0,80}0x20|0x20.{0,80}encrypted.?upload.?v2)/is
  );
  for (const suffix of ['0006', '0007', '0008', '0009', '000A', '000B']) {
    assert.equal(
      source.toUpperCase().includes(
        `B07A0004-${suffix}-1000-8000-00805F9B34FB`
      ),
      false,
      suffix
    );
  }
});

test('compatibility metadata reports contract evidence without runtime support', () => {
  const compatibility = JSON.parse(readFileSync(compatibilityPath, 'utf8'));
  assert.deepEqual(compatibility.encryptedUploadV2, {
    contractRevision: 'encrypted-upload-v2-contract-v1',
    contractVectors: true,
    rustCodec: true,
    appleFacadeInspection: true,
    androidFacadeInspection: true,
    reactNativeBridgeBytes: false,
    runtimeWorkflow: false,
    firmwareAdvertised: false,
    status: 'contract_only',
  });
});
