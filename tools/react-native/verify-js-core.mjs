import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runByoConformance } from './byo-conformance.mjs';
import { runManagedRouteConformance } from './managed-route-conformance.mjs';
import { runBoundModelConformance } from './bound-model-conformance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { createGeneratedJsCore } = require('../../frameworks/react-native/lib/commonjs/jsHost/core.js');
const factory = createGeneratedJsCore();
const engine = factory.createEngine();
const requests = [], expected = [];
const call = input => {
  requests.push(input);
  const response = engine.request(input);
  expected.push(response);
  return response;
};
const cancellation = Array(16).fill(7);
const candidate = { peripheral_id: 'selected', name: null, advertised_address: null, rssi: -60 };
const device = 'C8SU2XXWHI', recording = Array(16).fill(0x22);
const hint = { stored_peripheral_id: null, advertised_address: null, stored_name: null,
  scan_timeout_ms: '5000', connection_timeout_ms: '15000' };
const capabilities = ['Ble', 'Timer', 'Persistence', 'Progress', 'HostMaterial', 'RecordingSink', 'FirmwareBlob', 'NetworkTransfer'];
const codec = (name, input) => call({ version: 1, action: 'codec', codec: name, input });
runManagedRouteConformance(codec, (response, label) => {
  assert.equal(response.ok, true, `${label}: ${JSON.stringify(response)}`); return response.result;
}, (condition, message) => assert.ok(condition, message),
(actual, expected, message) => assert.deepEqual(actual, expected, message));
runBoundModelConformance(codec, (response, label) => {
  assert.equal(response.ok, true, `${label}: ${JSON.stringify(response)}`); return response.result;
}, (condition, message) => assert.ok(condition, message),
(actual, expected, message) => assert.deepEqual(actual, expected, message));
call({ version: 1, action: 'status' });
codec('protocolMetadata', {});
codec('encodeAck', { ack_type: 'ack', sequence: 65535 });
codec('encodeFirmwareData', { sequence: 513, payload: [0, 128, 255] });
codec('decodeText', { bytes: [0xe4, 0xb8, 0xad], required: true });
codec('decodeEncryptedUploadV2Capabilities', { bytes: [1, 2, 24, 0, 127, 0, 0, 0, 0, 4, 0, 4, 244, 0, 16, 0, 8, 0, 0, 0, 16, 0, 0, 0] });
const v2Capabilities = expected.at(-1).result;
runByoConformance(codec, (response, label) => {
  assert.equal(response.ok, true, `${label}: ${JSON.stringify(response)}`); return response.result;
}, (condition, message) => assert.ok(condition, message),
(actual, expected, message) => assert.deepEqual(actual, expected, message),
text => Uint8Array.from(Buffer.from(text, 'utf8')));
const localCapabilities = [2, 2, 16, 0, 31, 0, 0, 0, 3, 0, 185, 0, 182, 0, 182, 0];

const controlVector = JSON.parse(readFileSync(resolve(root, 'protocol/local-wifi-control-v1.vector.json'), 'utf8'));
const control = codec('localWifiTransfer', { op: 'ControlCreate', session_id: controlVector.sessionId, response_json: JSON.stringify(controlVector.response) });
assert.equal(control.ok, true);
const sealed = codec('localWifiTransfer', { op: 'ControlSeal', id: control.result.id, bytes: [...Buffer.from(controlVector.queryPlainHex, 'hex')] });
assert.equal(Buffer.from(sealed.result).toString('hex'), controlVector.queryWireHex);
const opened = codec('localWifiTransfer', { op: 'ControlOpen', id: control.result.id, bytes: [...Buffer.from(controlVector.replyWireHex, 'hex')] });
assert.equal(Buffer.from(opened.result).toString('hex'), controlVector.replyPlainHex);
assert.equal(codec('localWifiTransfer', { op: 'ControlOpen', id: control.result.id, bytes: [...Buffer.from(controlVector.replyWireHex, 'hex')] }).ok, false);
codec('localWifiTransfer', { op: 'ControlFree', id: control.result.id });

assert.equal(codec('localWifiTransfer', { op: 'Capabilities', bytes: localCapabilities, att_mtu: 185 }).ok, true);
assert.equal(codec('localWifiTransfer', { op: 'Capabilities', bytes: localCapabilities, att_mtu: 184 }).ok, false);
assert.equal(codec('localWifiTransfer', { op: 'Link', command: 0x10, session_id: '9007199254740993' }).ok, true);
const localRequest = { local_wifi: true, device, recording, recording_generation: 9, storage_format: 3,
  upload_session_uuid: Array(16).fill(0x11), owner_revision: 3, transport_session_id: '9007199254740993',
  material_id: 'material', sink_id: 'sink', selection: { policy: 'V2Preferred', profile: 'EncryptedUploadV2' },
  capabilities: v2Capabilities, window_packets: 16, data_payload_bytes: 244, ciphertext_length: '330', ciphertext_sha256: Array(32).fill(0x33) };
const localCreated = codec('localWifiTransfer', { op: 'Create', request: localRequest, authorization_sha256: Array(32).fill(4) });
assert.equal(localCreated.ok, true);
assert.equal(localCreated.result.frame.length, 84);
codec('localWifiTransfer', { op: 'Cancel', id: localCreated.result.id });
codec('localWifiTransfer', { op: 'Free', id: localCreated.result.id });
const localPlan = codec('planEncryptedUploadV2Request', { serialNumber: device,
  recording: { uuid: '22222222-2222-2222-2222-222222222222', generation: 9, ciphertextLength: '330', ciphertextSha256: '33'.repeat(32) },
  capabilityBytes: [1, 2, 24, 0, 127, 1, 0, 0, 0, 4, 0, 4, 244, 0, 16, 0, 8, 0, 0, 0, 16, 0, 0, 0],
  decision: { profile: 'encrypted_upload_v2', uploadSessionId: '11111111-1111-1111-1111-111111111111', ownerRevision: 3,
    securityPolicy: 'v2_preferred', materialRegistrationId: 'material' }, transportSessionId: '9007199254740993',
  sinkId: 'sink', maximumWriteBytes: 182, localWifi: true, localWifiCapabilityBytes: localCapabilities });
assert.equal(localPlan.ok, true); assert.equal(localPlan.result.local_wifi, true);
const managedLocalInput = { operationId: 'wifi-parity', scope: { apiOrigin: 'https://api.example.com', accountId: 'a', projectId: 'p',
  organizationId: '', environment: 'production', endUserId: 'eu_1', deviceId: 'dev_1', bindingGeneration: 1, serialNumber: device,
  nativeDeviceId: 'ble-id', scopeKey: 'a:p' }, recording: { uuid: '22222222-2222-2222-2222-222222222222', generation: 9,
  ciphertextLength: '330', ciphertextSha256: '33'.repeat(32), startedAtMs: '0', durationMs: '0', plaintextLength: '38', storageFormat: 3 },
  capability: { rawValueHex: '00'.repeat(24), flags: 0x37f, localWifiRawValueHex: Buffer.from(localCapabilities).toString('hex') } };
const managedLocal = codec('reduceManagedUpload', { input: managedLocalInput,
  event: { type: 'CreateSession', entry: { recordingId: 'rec_1' }, nonce: Array(16).fill(1) } });
assert.equal(managedLocal.ok, true);
const localBody = JSON.parse(managedLocal.result.value.bodyJSON);
assert.equal(localBody.channel, 'local_wifi'); assert.equal(localBody.local_wifi_capabilities_base64, Buffer.from(localCapabilities).toString('base64'));
const commands = [
  ['TransferRecording', { TransferEncryptedRecording: { request: localRequest } }],
  ['Discover', { DiscoverDevices: { timeout_ms: '5000', allow_duplicates: false } }],
  ['Connect', { Connect: { device, candidate } }],
  ['Connect', { ConnectSelected: { candidate } }],
  ['Reconnect', { Reconnect: { device, hint } }],
  ['Provision', { Provision: { device, material_id: 'material' } }],
  ['TransferRecording', { TransferRecording: { device, recording, sink_id: 'sink', total_units: '1024', confirm_on_completion: false } }],
  ['TransferRecording', { TransferEncryptedRecording: { request: { device, recording, recording_generation: 9, storage_format: 3,
    upload_session_uuid: Array(16).fill(0x11), owner_revision: 3, transport_session_id: '9007199254740993',
    material_id: 'material', sink_id: 'sink', selection: { policy: 'V2Preferred', profile: 'EncryptedUploadV2' },
    capabilities: v2Capabilities, window_packets: 16, data_payload_bytes: 244, ciphertext_length: '330', ciphertext_sha256: Array(32).fill(0x33) } } }],
  ['TransferRecording', { StreamRecording: { device, recording, sink_id: 'sink' } }],
  ['Upload', { UploadRecording: { device, recording, upload_id: 'upload', destination_id: 'destination' } }],
  ['UpdateFirmware', { UpdateFirmware: { device, image: { version: '1.2.3', size_bytes: 1024, crc32: 0x11223344 }, download_id: '9', reconnect_hint: hint } }],
  ['ReadDeviceLogs', { ReadDeviceLogs: { device } }],
  ['FactoryReset', { FactoryReset: { device, command_id: 'reset', grant_id: 'grant' } }],
  ['FactoryReset', { ResumeFactoryReset: { device, command_id: 'reset', expected_result: null } }],
];
let generation = 9007199254740993n;
for (const [operation, command] of commands) {
  const owner = { generation: (generation++).toString(), operation, cancellation_id: cancellation };
  const result = call({ version: 1, action: 'start', ...owner, command, capabilities });
  assert.equal(result.ok, true, `${Object.keys(command)[0]}: ${JSON.stringify(result)}`);
  const active = result.result.effects.find(effect => !effect.effect.Notify && !effect.effect.Progress);
  if (active) {
    call({ version: 1, action: 'dispatch', ...owner, cancellation_id: Array(16).fill(8),
      event: { request_id: active.request_id, kind: { Ble: 'WriteCompleted' } } });
  }
  call({ version: 1, action: 'cancel', ...owner });
}
engine.dispose();
const result = spawnSync('cargo', ['run', '--quiet', '--locked', '-p', 'bota-device-sdk-js', '--bin', 'js-trace'], {
  cwd: root, input: requests.map(request => JSON.stringify(request)).join('\n') + '\n',
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
});
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr);
const actual = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
assert.equal(actual.length, expected.length);
for (let index = 0; index < actual.length; index++) assert.deepEqual(actual[index], expected[index], `Native Rust / generated JS divergence at request ${index}`);
console.log(`Native Rust and generated JavaScript agree on ${actual.length} RPCs across all ${commands.length} core commands and the complete BYO batch action trace.`);
