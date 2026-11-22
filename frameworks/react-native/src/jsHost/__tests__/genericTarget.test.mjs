import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadSource } from './loadSource.mjs';

const { createGeneratedJsCore } = loadSource('core.ts');

test('generated core requires generic capability and exact retained material before accepting result 2', () => {
  const core = createGeneratedJsCore();
  try {
    const vectors = JSON.parse(readFileSync(new URL('../../../../../protocol/vectors/encrypted-upload-v2.json', import.meta.url), 'utf8'));
    const vector = name => Buffer.from(vectors.cases.find(value => value.name === name).inputHex, 'hex');
    const digest = value => createHash('sha256').update(value).digest();
    const capability = vector('capability'); capability.writeUInt32LE(0x17f, 4);
    const request = { local_wifi: false, device: 'C8SU2XXWHI', recording: [...Buffer.from('00112233445566778899aabbccddeeff', 'hex')],
      recording_generation: 9, storage_format: 3, upload_session_uuid: [...Buffer.from('101112131415161718191a1b1c1d1e1f', 'hex')],
      owner_revision: 3, transport_session_id: '18838586676582', material_id: 'material', sink_id: 'sink',
      selection: { policy: 'V2Required', profile: 'EncryptedUploadV2' }, capabilities: core.codec('decodeEncryptedUploadV2Capabilities', { bytes: [...capability] }),
      window_packets: 16, data_payload_bytes: 216, ciphertext_length: '330', ciphertext_sha256: [...digest(vector('storage-partial-block'))] };
    // Shape/binding tests only. Device signature verification is independently
    // exercised with signed generic documents in the firmware host tests.
    const authorization = vector('authorization-development'); authorization[30] |= 0x10;
    assert.throws(() => core.codec('validateEncryptedUploadV2Authorization', { request, bytes: [...authorization] }));
    capability.writeUInt32LE(0x77f, 4);
    request.capabilities = core.codec('decodeEncryptedUploadV2Capabilities', { bytes: [...capability] });
    core.codec('validateEncryptedUploadV2Authorization', { request, bytes: [...authorization] });
    const manifest = vector('manifest-hpke'), receipt = vector('completion-receipt'); receipt[13] = 2;
    digest(Buffer.concat([Buffer.from('bota/enc-v2/target-completion/v1'), authorization.subarray(280, 312),
      digest(manifest), Buffer.from(request.ciphertext_sha256)])).copy(receipt, 208);
    const payload = { request, bytes: [...receipt], markersRequired: false, authorization: [...authorization], manifest: [...manifest] };
    core.codec('validateEncryptedUploadV2Receipt', payload);
    for (const key of ['authorization', 'manifest']) {
      const missing = { ...payload }; delete missing[key];
      assert.throws(() => core.codec('validateEncryptedUploadV2Receipt', missing));
    }
    const changed = [...manifest]; changed[0] ^= 1;
    assert.throws(() => core.codec('validateEncryptedUploadV2Receipt', { ...payload, manifest: changed }));
    receipt[13] = 1;
    assert.throws(() => core.codec('validateEncryptedUploadV2Receipt', { ...payload, bytes: [...receipt] }));
  } finally { core.dispose(); }
});
