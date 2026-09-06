import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = join(packageRoot, '..', '..');
const vectorPath = join(workspaceRoot, 'protocol/vectors/encrypted-upload-v2.json');
const digestPath = join(
  workspaceRoot,
  'core/device-sdk-core/src/generated/encrypted_upload_v2_vectors.rs'
);
const compatibilityPath = join(
  workspaceRoot,
  'protocol/compatibility/firmware-compatibility.json'
);
const codegenContractPath = join(
  packageRoot,
  'generated/codegen-contract.json'
);
const appleAdapterPath = join(packageRoot, 'ios/BotaDeviceSDK.mm');
const androidAdapterPath = join(
  packageRoot,
  'android/src/main/java/dev/bota/sdk/reactnative/BotaDeviceSDKModule.kt'
);

test('encrypted upload v2 Codegen exposes only the approved metadata aliases', () => {
  const contract = JSON.parse(readFileSync(codegenContractPath, 'utf8'));
  const module = contract.schema.modules.NativeBotaDeviceSDK;
  const signature = (property) =>
    `${property.name}${property.optional ? '?' : '!'}:${property.typeAnnotation.type}${
      property.typeAnnotation.name === undefined
        ? ''
        : `(${property.typeAnnotation.name})`
    }`;
  const expectedProperties = {
    NativeEncryptedUploadV2Capability: [
      'durableCheckpointIntervalBlocks!:NumberTypeAnnotation',
      'encodingVersion!:NumberTypeAnnotation',
      'flags!:NumberTypeAnnotation',
      'maximumDataPayloadBytes!:NumberTypeAnnotation',
      'maximumManifestBytes!:NumberTypeAnnotation',
      'maximumMissingSequences!:NumberTypeAnnotation',
      'maximumSignedBlobBytes!:NumberTypeAnnotation',
      'maximumWindowPackets!:NumberTypeAnnotation',
      'rawValueHex!:StringTypeAnnotation',
      'sha256Hex!:StringTypeAnnotation',
      'transferProfileVersion!:NumberTypeAnnotation',
    ],
    NativeEncryptedUploadV2Checkpoint: [
      'dataPayloadBytes!:NumberTypeAnnotation',
      'highestContiguousSequence?:NumberTypeAnnotation',
      'nextCiphertextOffset!:StringTypeAnnotation',
      'ownerRevision!:NumberTypeAnnotation',
      'prefixSha256!:StringTypeAnnotation',
      'revision!:NumberTypeAnnotation',
      'sinkRegistrationId!:StringTypeAnnotation',
      'transportSessionId!:StringTypeAnnotation',
      'uploadSessionId!:StringTypeAnnotation',
      'version!:NumberTypeAnnotation',
      'windowPackets!:NumberTypeAnnotation',
    ],
    NativeEncryptedUploadV2ProfileDecision: [
      'materialRegistrationId!:StringTypeAnnotation',
      'ownerRevision!:NumberTypeAnnotation',
      'profile!:StringTypeAnnotation',
      'securityPolicy!:StringTypeAnnotation',
      'uploadSessionId!:StringTypeAnnotation',
    ],
    NativeEncryptedUploadV2ProfileRequest: [
      'capability!:TypeAliasTypeAnnotation(NativeEncryptedUploadV2Capability)',
      'checkpoint?:TypeAliasTypeAnnotation(NativeEncryptedUploadV2Checkpoint)',
      'operationId!:StringTypeAnnotation',
      'recording!:TypeAliasTypeAnnotation(NativeEncryptedUploadV2Recording)',
      'requestId!:StringTypeAnnotation',
    ],
    NativeEncryptedUploadV2Progress: [
      'checkpointRevision?:NumberTypeAnnotation',
      'completedBytes!:StringTypeAnnotation',
      'errorCode?:StringTypeAnnotation',
      'operationId!:StringTypeAnnotation',
      'phase!:StringTypeAnnotation',
      'protocolStatus?:NumberTypeAnnotation',
      'recordingUuid!:StringTypeAnnotation',
      'retryable?:BooleanTypeAnnotation',
      'totalBytes!:StringTypeAnnotation',
    ],
    NativeEncryptedUploadV2Recording: [
      'ciphertextLength!:StringTypeAnnotation',
      'ciphertextSha256!:StringTypeAnnotation',
      'generation!:NumberTypeAnnotation',
      'uuid!:StringTypeAnnotation',
    ],
  };

  const v2Aliases = Object.fromEntries(
    Object.entries(module.aliasMap)
      .filter(([name]) => name.startsWith('NativeEncryptedUploadV2'))
      .map(([name, alias]) => [
        name,
        alias.properties.map(signature).sort(),
      ])
  );
  assert.deepEqual(v2Aliases, expectedProperties);

  const v2Events = module.spec.eventEmitters
    .filter((event) => event.name.includes('EncryptedUploadV2'))
    .map((event) => [
      event.name,
      event.typeAnnotation.typeAnnotation.name,
    ]);
  assert.deepEqual(v2Events, [
    [
      'onEncryptedUploadV2ProfileRequested',
      'NativeEncryptedUploadV2ProfileRequest',
    ],
    ['onEncryptedUploadV2Progress', 'NativeEncryptedUploadV2Progress'],
  ]);

  const v2Methods = Object.fromEntries(
    module.spec.methods
      .filter((method) =>
        /Encrypted(?:UploadV2|RecordingV2)/.test(method.name)
      )
      .map((method) => [
        method.name,
        method.typeAnnotation.params.map(signature),
      ])
  );
  assert.deepEqual(v2Methods, {
    rejectEncryptedUploadV2Profile: [
      'requestId!:StringTypeAnnotation',
      'errorCode!:StringTypeAnnotation',
    ],
    resolveEncryptedUploadV2Profile: [
      'requestId!:StringTypeAnnotation',
      'decision!:TypeAliasTypeAnnotation(NativeEncryptedUploadV2ProfileDecision)',
    ],
    syncEncryptedRecordingV2: [
      'device!:TypeAliasTypeAnnotation(NativeConnectedDevice)',
      'recording!:TypeAliasTypeAnnotation(NativeEncryptedUploadV2Recording)',
      'operationId!:StringTypeAnnotation',
    ],
  });
});

test('encrypted upload v2 Codegen rejects bulk data and sensitive native material', () => {
  const contract = JSON.parse(readFileSync(codegenContractPath, 'utf8'));
  const aliases = contract.schema.modules.NativeBotaDeviceSDK.aliasMap;
  const module = contract.schema.modules.NativeBotaDeviceSDK;
  const names = Object.entries(aliases)
    .filter(([name]) => name.startsWith('NativeEncryptedUploadV2'))
    .flatMap(([, alias]) => alias.properties.map((property) => property.name))
    .concat(
      module.spec.methods
        .filter((method) =>
          /Encrypted(?:UploadV2|RecordingV2)/.test(method.name)
        )
        .flatMap((method) =>
          method.typeAnnotation.params.map((parameter) => parameter.name)
        )
    );
  const forbidden = [
    /^(?:data|payload|bytes|chunk)$/i,
    /^ciphertext(?:data|payload|bytes|chunk|base64)?$/i,
    /^authorization(?:document|data|payload|bytes|base64)?$/i,
    /^manifest(?:document|data|payload|bytes|chunk|base64)?$/i,
    /^receipt(?:document|data|payload|bytes|base64)?$/i,
    /staging(?:url|header|headers|credential|credentials)/i,
    /(?:native|recording|file)(?:bytes|data|payload|path)$/i,
    /(?:privatekey|secretkey|wrappingkey|encryptionkey|nonce|aeadtag)$/i,
  ];

  for (const name of names) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(name, pattern, `${name} crosses the v2 Codegen boundary`);
    }
  }
});

test('encrypted upload v2 Promise failures expose only a stable sanitized error', () => {
  const apple = readFileSync(appleAdapterPath, 'utf8');
  const android = readFileSync(androidAdapterPath, 'utf8');

  assert.match(apple, /BotaRejectEncryptedUploadV2Error\(reject\)/);
  assert.match(
    apple,
    /reject\(@"encrypted_upload_v2_failed", @"encrypted upload v2 failed", nil\)/
  );
  assert.match(android, /launchEncryptedUploadV2\(promise\)/);
  assert.match(
    android,
    /promise\.reject\(ENCRYPTED_UPLOAD_V2_ERROR_CODE, "encrypted upload v2 failed"\)/
  );
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
