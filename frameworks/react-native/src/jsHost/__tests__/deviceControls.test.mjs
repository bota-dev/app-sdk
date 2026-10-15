import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';

const { JsDeviceControls } = loadSource('deviceControls.ts');

const characteristics = ['SERIAL_NUMBER', 'MODEL_NUMBER', 'FIRMWARE_REVISION', 'HARDWARE_REVISION',
  'DEVICE_STATUS', 'DEVICE_COMMAND', 'RECORDING_CONTROL', 'RECORDING_STATUS', 'TIME_SYNC',
  'PAIRING_STATE', 'API_ENDPOINT', 'DEVICE_SETTINGS', 'PK_D', 'AUTH_NONCE', 'DEVICE_CERT',
  'BACKEND_PUBKEY', 'WIFI_GRANT', 'WIFI_CREDENTIAL', 'WIFI_STATUS', 'WIFI_SCAN',
  'DEVICE_LOG_CONTROL', 'DEVICE_LOG_DATA'];
const services = ['DEVICE_INFO', 'BOTA_CONTROL', 'BOTA_PROVISIONING', 'BOTA_AUTH',
  'BOTA_WIFI_CONFIG', 'BOTA_DIAGNOSTICS'];
const metadata = Object.fromEntries([...characteristics.map(name => [`CHAR_${name}`, name]),
  ...services.map(name => [`SERVICE_${name}`, name]), ['recordingStopDelayMs', 0], ['operationTimeoutMs', 1000]]);
const device = { id: 'peripheral-1', serialNumber: 'BOTA-001', deviceType: 'pin',
  firmwareVersion: '1.0.19', mtu: 247, isProvisioned: true, connectionState: 'connected' };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides = {}, scope = {}) {
  const calls = [];
  const codecCalls = [];
  const subscribers = new Map();
  const events = [];
  const cleanupFailures = [];
  const cleanupFailed = deferred();
  const controller = new AbortController();
  const context = { operation: 'DeviceControl', operationId: 'control-1', requestId: '0',
    cancellationId: '01'.repeat(16), generation: '1', signal: controller.signal };
  let current = { device, generation: 'connection-1' };
  const core = { codec(name, input) {
    codecCalls.push({ name, input });
    switch (name) {
      case 'protocolMetadata': return { ...metadata, ...overrides };
      case 'decodeText': return input.bytes[0] === 255 ? 'OTHER-DEVICE' : device.serialNumber;
      case 'decodeDeviceStatus': return { batteryLevel: 91, timestamp: input.timestampMs };
      case 'decodeProvisioningState': return true;
      case 'decodeHex': return input.length === 64 ? 'rust-public-key' : 'rust-nonce';
      case 'decodeConnectionSettings': return { streamingEnabled: false };
      case 'decodeRecordingState': return { active: true, initiatedBy: 'remote', recordingId: 'rust-uuid' };
      case 'decodeRecordingControlNotification': return input.bytes[0] === 1 ? null
        : { success: input.bytes[0] !== 9, ...(input.bytes[0] === 9 ? { error: 'invalid_grant' } : {}) };
      case 'decodeWiFiConfigResult': return { success: true };
      case 'decodeWiFiStatus': return { status: 'connected', ssid: 'rust-wifi' };
      case 'decodeWiFiScanUpdate': return input.bytes[0] === 1 ? { kind: 'pending' }
        : { kind: 'done', result: { networks: [{ ssid: 'rust-wifi', quality: 80, isCurrent: true, isOpen: false }] } };
      case 'resetDeviceLogs': return null;
      case 'decodeDeviceLogs': return [{ message: 'rust-log-line', isBacklog: false }];
      case 'resetDiagnostics': return null;
      case 'decodeDiagnostics': return input.bytes[0] === 1 ? null : {
        schema_version: 1, events: [{ event_id: '0123456789abcdef', event_type: 'hard_fault',
          report: { fault: { cpu_id: 0 }, execution: { task: 'rust-task', pc_trace: [] } } }],
      };
      case 'encodeDiagnosticsList': return [116];
      case 'encodeDiagnosticsAcknowledge': {
        if (input.eventId === 'invalid') throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' });
        return [117, input.eventId === '0123456789abcdef' ? 1 : 2];
      }
      case 'encodeCertificateChunks': return [[101, 1], [101, 2]];
      case 'encodeDeviceLogControl': return [input.enabled ? 102 : 103];
      case 'encodeGrant': {
        if (!input.grantBlob) throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' });
        return [110];
      }
      case 'encodeWiFiGrant': return [111];
      case 'encodeRecordingControlCommand': return [112];
      case 'encodeWiFiCredentials': return [113];
      case 'encodeWiFiScanCommand': return [114];
      default: if (name.startsWith('encode')) return [115];
    }
    throw new Error(`Missing fixture codec ${name}`);
  } };
  const ble = {
    async read(address) { calls.push(['read', address.characteristicUuid, address.peripheralId]); return Uint8Array.of(0); },
    async write(address, bytes, withResponse) {
      calls.push(['write', address.characteristicUuid, [...bytes], withResponse]);
      if (['RECORDING_CONTROL', 'WIFI_CREDENTIAL'].includes(address.characteristicUuid)) {
        subscribers.get(address.characteristicUuid === 'RECORDING_CONTROL' ? 'RECORDING_STATUS' : 'WIFI_CREDENTIAL')?.(Uint8Array.of(0));
      }
      if (address.characteristicUuid === 'WIFI_SCAN') subscribers.get('WIFI_SCAN')?.(Uint8Array.of(0));
    },
    async subscribe(address, onValue) {
      calls.push(['subscribe', address.characteristicUuid]);
      subscribers.set(address.characteristicUuid, onValue);
      return { async remove() { calls.push(['remove', address.characteristicUuid]);
        if (subscribers.get(address.characteristicUuid) === onValue) subscribers.delete(address.characteristicUuid); } };
    },
  };
  const controls = new JsDeviceControls({ core, ports: { ble, persistence: { namespace: 'test/customer' }, ...scope }, connection: () => current,
    emit: (event, value) => events.push({ event, value }), gatt: (_context, body) => body(),
    onCleanupFailure(error, context) { cleanupFailures.push({ error, context }); cleanupFailed.resolve(error); } });
  return { controls, core, ble, calls, codecCalls, context, controller, subscribers, events, cleanupFailures, cleanupFailed,
    setConnection(next) { current = next; } };
}

test('passive callbacks are fenced and joined on logout with no active direct operation', async () => {
  const scope = new AbortController();
  const f = fixture({}, { signal: scope.signal });
  await f.controls.execute('startStatusUpdates', [], f.context);
  const captured = f.subscribers.get('DEVICE_STATUS');
  scope.abort();
  captured(Uint8Array.of(1));
  await f.controls.close();
  assert.equal(f.events.length, 0);
  assert.equal(f.calls.filter(call => call[0] === 'remove').length, 1);
  captured(Uint8Array.of(2));
  assert.equal(f.events.length, 0);
});

test('public metadata reads go through the Rust bridge after physical serial verification', async () => {
  const f = fixture();
  assert.deepEqual(await f.controls.execute('readStatus', [], f.context), { batteryLevel: 91, timestamp: f.codecCalls.at(-1).input.timestampMs });
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['read', 'SERIAL_NUMBER'], ['read', 'DEVICE_STATUS']]);
  assert.equal(f.calls[0][2], device.id);
  assert.equal(await f.controls.execute('isProvisioned', [device], f.context), true);
  assert.equal(await f.controls.execute('readPublicKey', [device], f.context), 'rust-public-key');
  assert.equal(await f.controls.execute('readAuthNonce', [device], f.context), 'rust-nonce');
  await f.controls.close();
});

test('physical serial mismatch and stale requested identity cannot submit control writes', async () => {
  const f = fixture();
  f.ble.read = async () => Uint8Array.of(255);
  await assert.rejects(f.controls.execute('syncTime', [device], f.context), { code: 'identity_mismatch' });
  await assert.rejects(f.controls.execute('requestStartRecording', [{ ...device, id: 'other' }, 'grant'], f.context), { code: 'identity_mismatch' });
  assert.equal(f.calls.filter(call => call[0] === 'write').length, 0);
  await f.controls.close();
});

test('recording subscribes before grant and command, ignores pre-command callbacks, and delegates acceptance', async () => {
  const f = fixture();
  const write = f.ble.write;
  f.ble.write = async (...args) => {
    if (args[0].characteristicUuid === 'DEVICE_COMMAND') f.subscribers.get('RECORDING_STATUS')?.(Uint8Array.of(9));
    if (args[0].characteristicUuid === 'RECORDING_CONTROL') f.subscribers.get('RECORDING_STATUS')?.(Uint8Array.of(1));
    await write(...args);
  };
  assert.deepEqual(await f.controls.execute('requestStartRecording', [device, 'grant'], f.context), { success: true });
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['read', 'SERIAL_NUMBER'],
    ['subscribe', 'RECORDING_STATUS'], ['write', 'DEVICE_COMMAND'], ['write', 'RECORDING_CONTROL'], ['remove', 'RECORDING_STATUS']]);
  const decode = f.codecCalls.filter(call => call.name === 'decodeRecordingControlNotification');
  assert.deepEqual(decode.map(call => call.input.bytes), [[1], [0]]);
  assert.equal(decode[0].input.action, 'start');
  assert.deepEqual(f.calls.filter(call => call[0] === 'write').map(call => call[2]), [[110], [112]]);
  await f.controls.close();
});

test('cancellation joins a submitted grant write before releasing the subscription or queue', async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  f.ble.write = async address => {
    f.calls.push(['write', address.characteristicUuid]);
    entered.resolve();
    await release.promise;
  };
  const pending = f.controls.execute('requestStartRecording', [device, 'grant'], f.context);
  await entered.promise;
  f.controller.abort();
  const closed = f.controls.close();
  assert.equal(f.calls.some(call => call[0] === 'remove'), false);
  release.resolve();
  await assert.rejects(pending, { code: 'cancelled' });
  await closed;
  assert.deepEqual(f.calls.filter(call => ['write', 'remove'].includes(call[0])),
    [['write', 'DEVICE_COMMAND'], ['remove', 'RECORDING_STATUS']]);
});

test('cancellation during subscribe removes the late subscription without writing', async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  f.ble.subscribe = async () => {
    entered.resolve();
    await release.promise;
    return { async remove() { f.calls.push(['remove', 'late']); } };
  };
  const pending = f.controls.execute('requestStopRecording', [device, 'grant'], f.context);
  await entered.promise;
  f.controller.abort();
  release.resolve();
  await assert.rejects(pending, { code: 'cancelled' });
  assert.deepEqual(f.calls.filter(call => ['write', 'remove'].includes(call[0])), [['remove', 'late']]);
  await f.controls.close();
});

test('a replacement connection fences queued writes even when its peripheral and serial match', async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  f.ble.write = async address => {
    f.calls.push(['write', address.characteristicUuid]);
    entered.resolve();
    await release.promise;
  };
  const pending = f.controls.execute('requestStartRecording', [device, 'grant'], f.context);
  await entered.promise;
  f.setConnection({ device, generation: 'connection-2' });
  release.resolve();
  await assert.rejects(pending, { code: 'identity_mismatch' });
  assert.equal(f.calls.some(call => call[1] === 'RECORDING_CONTROL'), false);
  await f.controls.close();
});

test('WiFi requires configuration authorization and subscribes before ordered grant/credentials', async () => {
  const f = fixture();
  await assert.rejects(f.controls.execute('configureWiFi', [device, 'ssid', 'password'], f.context), { code: 'invalid_input' });
  assert.deepEqual(await f.controls.execute('configureWiFi', [device, 'ssid', 'password', 'wifi-grant'], f.context), { success: true });
  assert.deepEqual(f.calls.filter(call => ['subscribe', 'write', 'remove'].includes(call[0])).map(call => call.slice(0, 2)),
    [['subscribe', 'WIFI_CREDENTIAL'], ['write', 'WIFI_GRANT'], ['write', 'WIFI_CREDENTIAL'], ['remove', 'WIFI_CREDENTIAL']]);
  assert.deepEqual(await f.controls.execute('scanWiFiNetworks', [device], f.context),
    { networks: [{ ssid: 'rust-wifi', quality: 80, isCurrent: true, isOpen: false }] });
  await f.controls.close();
});

test('certificate chunks are written sequentially without handwritten framing', async () => {
  const f = fixture();
  await f.controls.execute('deliverCertificate', [device, 'cert', 'private'], f.context);
  assert.deepEqual(f.calls.filter(call => call[0] === 'write').map(call => call[2]), [[101, 1], [101, 2]]);
  assert.deepEqual(f.codecCalls.find(call => call.name === 'encodeCertificateChunks').input,
    { certificatePem: 'cert', privateKeyPem: 'private', mtu: 247 });
  await f.controls.close();
});

test('passive updates ignore replacement-owner notifications and remove the captured subscription', async () => {
  const f = fixture();
  await f.controls.execute('startStatusUpdates', [], f.context);
  const notify = f.subscribers.get('DEVICE_STATUS');
  notify(Uint8Array.of(0));
  assert.equal(f.events[0].event, 'onDeviceStatusUpdated');
  f.setConnection({ device, generation: 'connection-2' });
  notify(Uint8Array.of(0));
  await f.controls.execute('stopStatusUpdates', [], f.context);
  assert.equal(f.events.length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'remove').length, 1);
  await f.controls.close();
});

test('logs use Rust decoder state, subscribe before start, and stop before removing', async () => {
  const f = fixture();
  await f.controls.execute('startDeviceLogs', [device], f.context);
  f.subscribers.get('DEVICE_LOG_DATA')(Uint8Array.of(0));
  assert.deepEqual(f.events, [{ event: 'onDeviceLog', value: { message: 'rust-log-line', isBacklog: false } }]);
  await f.controls.execute('stopDeviceLogs', [], f.context);
  assert.deepEqual(f.calls.filter(call => ['subscribe', 'write', 'remove'].includes(call[0])).map(call => [call[0], call[1], call[2]]),
    [['subscribe', 'DEVICE_LOG_DATA', undefined], ['write', 'DEVICE_LOG_CONTROL', [102]],
      ['write', 'DEVICE_LOG_CONTROL', [103]], ['remove', 'DEVICE_LOG_DATA', undefined]]);
  const reset = f.codecCalls.filter(call => call.name === 'resetDeviceLogs');
  assert.equal(reset.length, 2);
  assert.equal(reset[0].input.decoderId, reset[1].input.decoderId);
  await f.controls.close();
});

test('result timeout removes the captured subscription and keeps Rust rejection details', async () => {
  const f = fixture({ operationTimeoutMs: 25 });
  f.ble.write = async address => { f.calls.push(['write', address.characteristicUuid]); };
  await assert.rejects(f.controls.execute('requestStartRecording', [device, 'grant'], f.context), { code: 'timeout' });
  assert.equal(f.calls.filter(call => call[0] === 'remove').length, 1);
  f.ble.write = async address => {
    if (address.characteristicUuid === 'RECORDING_CONTROL') f.subscribers.get('RECORDING_STATUS')(Uint8Array.of(9));
  };
  assert.deepEqual(await f.controls.execute('requestStartRecording', [device, 'grant'], f.context),
    { success: false, error: 'invalid_grant' });
  await f.controls.close();
});

test('close uses its current lease for log STOP and never writes STOP to a replacement connection', async () => {
  for (const replace of [false, true]) {
    const f = fixture();
    await f.controls.execute('startDeviceLogs', [device], f.context);
    if (replace) f.setConnection({ device, generation: 'connection-2' });
    await f.controls.close({ ...f.context, operationId: 'close-2', generation: '2' });
    const writes = f.calls.filter(call => call[0] === 'write');
    assert.deepEqual(writes.map(call => call[2]), replace ? [[102]] : [[102], [103]]);
    assert.equal(f.calls.filter(call => call[0] === 'remove').length, 1);
  }
});

test('diagnostic LIST subscribes before command, waits for Rust completion, and resets the exact decoder', async () => {
  const f = fixture();
  f.ble.write = async (address, value) => {
    f.calls.push(['write', address.characteristicUuid, [...value]]);
    f.subscribers.get('DEVICE_LOG_DATA')(Uint8Array.of(1));
    f.subscribers.get('DEVICE_LOG_DATA')(Uint8Array.of(0));
  };
  const result = await f.controls.execute('readDiagnosticEvents', [device], f.context);
  assert.deepEqual(result, { schema_version: 1, events: [{ event_id: '0123456789abcdef', event_type: 'hard_fault',
    report: { fault: { cpu_id: 0 }, execution: { task: 'rust-task', pc_trace: [] } } }] });
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['read', 'SERIAL_NUMBER'],
    ['subscribe', 'DEVICE_LOG_DATA'], ['write', 'DEVICE_LOG_CONTROL'], ['remove', 'DEVICE_LOG_DATA']]);
  assert.deepEqual(f.codecCalls.filter(call => call.name === 'decodeDiagnostics').map(call => call.input.bytes), [[1], [0]]);
  const resets = f.codecCalls.filter(call => call.name === 'resetDiagnostics');
  assert.equal(resets.length, 2);
  assert.equal(resets[0].input.decoderId, resets[1].input.decoderId);
  await f.controls.close();
});

test('diagnostic acknowledgement validates every selected ID before the first mutation', async () => {
  const f = fixture();
  await assert.rejects(f.controls.execute('acknowledgeDiagnosticEvents',
    [device, ['0123456789abcdef', 'invalid']], f.context), { code: 'invalid_input' });
  assert.equal(f.calls.some(call => call[0] === 'write'), false);
  await f.controls.execute('acknowledgeDiagnosticEvents',
    [device, ['0123456789abcdef', 'fedcba9876543210']], f.context);
  assert.deepEqual(f.calls.filter(call => call[0] === 'write').map(call => call[2]), [[117, 1], [117, 2]]);
  assert.deepEqual(f.codecCalls.filter(call => call.name === 'encodeDiagnosticsAcknowledge').map(call => call.input.eventId),
    ['0123456789abcdef', 'invalid', '0123456789abcdef', 'fedcba9876543210']);
  await f.controls.close();
});

test('diagnostic acknowledgement joins cancellation of a submitted write and sends no successor ACK', async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  f.ble.write = async (address, bytes) => {
    f.calls.push(['write', address.characteristicUuid, [...bytes]]);
    entered.resolve();
    await release.promise;
  };
  const pending = f.controls.execute('acknowledgeDiagnosticEvents',
    [device, ['0123456789abcdef', 'fedcba9876543210']], f.context);
  await entered.promise;
  f.controller.abort();
  const closing = f.controls.close();
  release.resolve();
  await assert.rejects(pending, { code: 'cancelled' });
  await closing;
  assert.equal(f.calls.filter(call => call[0] === 'write').length, 1);
});

test('diagnostic startup cancellation removes a late subscription and resets without LIST', async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  f.ble.subscribe = async () => {
    entered.resolve();
    await release.promise;
    return { async remove() { f.calls.push(['remove', 'diagnostic-startup']); } };
  };
  const pending = f.controls.execute('readDiagnosticEvents', [device], f.context);
  await entered.promise;
  f.controller.abort();
  release.resolve();
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(f.calls.some(call => call[0] === 'write'), false);
  assert.equal(f.calls.filter(call => call[0] === 'remove').length, 1);
  assert.equal(f.codecCalls.filter(call => call.name === 'resetDiagnostics').length, 2);
  await f.controls.close();
});

test('diagnostics cannot replace an active log monitor or acknowledge events under its lease', async () => {
  const f = fixture();
  await f.controls.execute('startDeviceLogs', [device], f.context);
  const monitor = f.subscribers.get('DEVICE_LOG_DATA');
  await assert.rejects(f.controls.execute('readDiagnosticEvents', [device], f.context), { code: 'operation_in_progress' });
  await assert.rejects(f.controls.execute('acknowledgeDiagnosticEvents', [device, ['0123456789abcdef']], f.context), { code: 'operation_in_progress' });
  assert.equal(f.subscribers.get('DEVICE_LOG_DATA'), monitor);
  assert.equal(f.codecCalls.some(call => call.name.startsWith('encodeDiagnostics')), false);
  await f.controls.close(f.context);
});

test('diagnostic cleanup failure stays visible and clears Rust decoder state', async () => {
  const f = fixture();
  const cleanupError = Object.assign(new Error('remove_failed'), { code: 'remove_failed' });
  let removals = 0;
  f.ble.subscribe = async (_address, callback) => {
    f.subscribers.set('DEVICE_LOG_DATA', callback);
    return { async remove() { removals++; if (removals === 1) throw cleanupError; } };
  };
  f.ble.write = async () => { f.subscribers.get('DEVICE_LOG_DATA')(Uint8Array.of(0)); };
  await assert.rejects(f.controls.execute('readDiagnosticEvents', [device], f.context), error => error === cleanupError);
  assert.equal(f.codecCalls.filter(call => call.name === 'resetDiagnostics').length, 2);
  assert.equal(f.cleanupFailures[0].error, cleanupError);
  assert.equal(f.cleanupFailures[0].context.operationId, f.context.operationId);
  const before = f.calls.length;
  await assert.rejects(f.controls.execute('readStatus', [], f.context), error => error === cleanupError);
  assert.equal(f.calls.length, before);
  await f.controls.close();
  assert.equal(removals, 2);
});

test('passive unsubscribe failure poisons controls and close retries only its captured monitor', async () => {
  const f = fixture();
  const cleanupError = new Error('passive_remove_failed');
  let removals = 0;
  f.ble.subscribe = async (_address, callback) => {
    f.subscribers.set('DEVICE_STATUS', callback);
    return { async remove() { removals++; if (removals === 1) throw cleanupError; } };
  };
  await f.controls.execute('startStatusUpdates', [], f.context);
  f.setConnection({ device, generation: 'connection-2' });
  f.subscribers.get('DEVICE_STATUS')(Uint8Array.of(0));
  assert.equal(await f.cleanupFailed.promise, cleanupError);
  const before = f.calls.length;
  await assert.rejects(f.controls.execute('readStatus', [], f.context), error => error === cleanupError);
  assert.equal(f.calls.length, before);
  await f.controls.close(f.context);
  assert.equal(removals, 2);
});

test('failed log STOP invokes owner retention, suppresses future IO, and close still removes the exact subscription', async () => {
  const f = fixture();
  await f.controls.execute('startDeviceLogs', [device], f.context);
  const cleanupError = new Error('log_stop_failed');
  const write = f.ble.write;
  let stops = 0;
  f.ble.write = async (...args) => {
    if (args[1][0] === 103 && ++stops === 1) throw cleanupError;
    return write(...args);
  };
  await assert.rejects(f.controls.execute('stopDeviceLogs', [], f.context), error => error === cleanupError);
  assert.equal(f.cleanupFailures[0].error, cleanupError);
  const before = f.calls.length;
  await assert.rejects(f.controls.execute('readDiagnosticEvents', [device], f.context), error => error === cleanupError);
  assert.equal(f.calls.length, before);
  await f.controls.close(f.context);
  assert.equal(stops, 2);
  assert.equal(f.calls.filter(call => call[0] === 'remove').length, 2);
});

function diagnosticPackets() {
  // The existing canonical full-detail fixture from device-diagnostics-decoder.test.mjs.
  const metadata = Buffer.from('900003050045fd0e002a00000000000000', 'hex');
  const signature = Buffer.from('9100efcdab8967452301', 'hex');
  const detail = Buffer.alloc(176);
  detail[0] = 1; detail[1] = 1;
  detail.write('a4f02973d61c', 2, 'ascii');
  detail[15] = 2; detail[17] = 1; detail[18] = 1; detail[19] = 3;
  detail.writeUInt32LE(8, 20);
  detail.writeUInt32LE(0x80014bd0, 40);
  detail.writeUInt32LE(0x400082a4, 44);
  detail.writeUInt32LE(0x00004118, 48);
  detail.writeUInt32LE(18320, 72); detail.writeUInt32LE(4096, 76);
  detail.write('btstack', 80, 'ascii');
  detail.writeInt32LE(-210, 96); detail.writeUInt16LE(3, 100); detail.writeInt32LE(2, 102);
  const chunks = [];
  for (let offset = 0; offset < detail.length; offset += 14) {
    chunks.push(Buffer.concat([Buffer.from([0x95, 0, offset & 255, offset >> 8, 176, 0]), detail.subarray(offset, offset + 14)]));
  }
  return [metadata, signature, ...chunks, Buffer.from([0x92, 1])];
}

test('generated Rust diagnostic adapter preserves the Native full report and exact 64-bit ACK ID bytes', async () => {
  const { createGeneratedJsCore } = loadSource('core.ts');
  const core = createGeneratedJsCore();
  const metadata = core.codec('protocolMetadata', {});
  let notify;
  const writes = [];
  const context = { operation: 'ReadDeviceLogs', operationId: 'generated-diagnostics-1', requestId: '0',
    generation: '1', cancellationId: '01'.repeat(16), signal: new AbortController().signal };
  const controls = new JsDeviceControls({ core,
    connection: () => ({ device, generation: 'connection-1' }), emit() {}, gatt: (_context, body) => body(),
    ports: { persistence: { namespace: 'test/customer' }, ble: {
      async read() { return Uint8Array.from(Buffer.from(device.serialNumber)); },
      async subscribe(address, callback) {
        assert.equal(address.characteristicUuid, metadata.CHAR_DEVICE_LOG_DATA);
        notify = callback;
        return { async remove() { notify = undefined; } };
      },
      async write(address, bytes) {
        assert.equal(address.characteristicUuid, metadata.CHAR_DEVICE_LOG_CONTROL);
        writes.push(Buffer.from(bytes).toString('hex'));
        if (writes.at(-1) === '10') for (const packet of diagnosticPackets()) notify(packet);
      },
    } },
  });
  const batch = await controls.execute('readDiagnosticEvents', [device], context);
  assert.deepEqual(batch, { schema_version: 1, events: [{
    event_id: '000000000000002a', event_type: 'hard_fault', reason_code: 'cpu_usage_fault',
    uptime_ms: 982341, signature: '0123456789abcdef', firmware_build_id: 'a4f02973d61c',
    subsystem: 'system', state_before_event: 'recording', report: {
      fault: { cpu_id: 0, cpu_emu: '00000008', core_emu: '00000000', hsb_emu: '00000000', audio_emu: '00000000', wireless_emu: '00000000' },
      execution: { task: 'btstack', reti: 'sdram:00014bd0', rets: 'ram:000082a4', pc_trace: ['rom:00004118'] },
      runtime: { heap_free_bytes: 18320, task_stack_remaining_bytes: 4096 },
      breadcrumbs: [{ delta_ms: -210, code: 'recording_started', arg0: 2 }],
    },
  }] });
  await assert.rejects(controls.execute('acknowledgeDiagnosticEvents',
    [device, ['0123456789abcdef', '0123456789ABCDEF']], context), { code: 'invalid_input' });
  assert.deepEqual(writes, ['10']);
  await controls.execute('acknowledgeDiagnosticEvents', [device, ['0123456789abcdef']], context);
  assert.deepEqual(writes, ['10', '11efcdab8967452301']);
  await controls.close();
});

function modelSettingsFixture(model = 'BOTA_DEV', resolver) {
  const { createGeneratedJsCore } = loadSource('core.ts');
  const core = createGeneratedJsCore();
  const connected = { ...device, serialNumber: '4KF6NOHWX0', deviceType: model };
  const writes = [];
  let current = { device: connected, generation: 'model-connection-1' };
  const abort = new AbortController();
  const context = { operation: 'WriteConnectionSettings', operationId: 'settings-1', requestId: '0',
    generation: '1', cancellationId: '01'.repeat(16), signal: abort.signal };
  const settings = core.codec('decodeConnectionSettings', { bytes: [2, 3, 1, 2, 3, 18, 18, 0, 60, 0x83, 0, 0] });
  const controls = new JsDeviceControls({ core, connection: () => current,
    resolveBoundDeviceModel: resolver, emit() {}, gatt: (_context, body) => body(),
    ports: { persistence: { namespace: 'test/customer' }, ble: {
      async read() { return Uint8Array.from(Buffer.from(connected.serialNumber)); },
      async write(_address, bytes) { writes.push([...bytes]); },
    } },
  });
  return { core, controls, connected, writes, settings, context, abort,
    rebind() { current = { device: connected, generation: 'model-connection-2' }; } };
}

test('actual Rust settings codec resolves only exact authenticated generic-model hints and retains raw GATT identity', async () => {
  for (const model of ['pin', 'note']) {
    const f = modelSettingsFixture('BOTA_DEV', (serialNumber, context) => {
      assert.equal(serialNumber, '4KF6NOHWX0');
      assert.equal(context.operationId, 'settings-1');
      return { serialNumber, model, bindingGeneration: 3 };
    });
    try {
      await f.controls.execute('writeConnectionSettings', [{ ...f.connected, deviceType: 'note' }, f.settings], f.context);
      assert.deepEqual(f.writes, [f.core.codec('encodeConnectionSettings', { settings: f.settings, model })]);
      assert.equal(f.connected.deviceType, 'BOTA_DEV');
    } finally { await f.controls.close(); f.core.dispose(); }
  }
});

test('actual Rust settings admission rejects missing, malformed, conflicting or arbitrary model hints before writes', async () => {
  const hint = { serialNumber: '4KF6NOHWX0', model: 'pin', bindingGeneration: 3 };
  for (const [observed, supplied] of [
    ['BOTA_DEV', null], ['unknown', hint], ['note', hint],
    ['BOTA_DEV', { ...hint, serialNumber: 'OTHERDEVICE' }],
    ['BOTA_DEV', { ...hint, bindingGeneration: 0 }],
    ['BOTA_DEV', { ...hint, bindingGeneration: Number.MAX_SAFE_INTEGER + 1 }],
    ['BOTA_DEV', { ...hint, model: 'BOTA_DEV' }],
  ]) {
    const f = modelSettingsFixture(observed, () => supplied);
    try {
      await assert.rejects(f.controls.execute('writeConnectionSettings', [f.connected, f.settings], f.context));
      assert.deepEqual(f.writes, []);
    } finally { await f.controls.close(); f.core.dispose(); }
  }
  const known = modelSettingsFixture('pin');
  try {
    await known.controls.execute('writeConnectionSettings', [known.connected, known.settings], known.context);
    assert.equal(known.writes.length, 1);
  } finally { await known.controls.close(); known.core.dispose(); }
});

test('pending model resolution keeps the operation joined and cannot write after cancellation or physical rebind', async () => {
  for (const invalidation of ['cancel', 'rebind']) {
    const entered = deferred();
    const resolution = deferred();
    const f = modelSettingsFixture('BOTA_DEV', () => { entered.resolve(); return resolution.promise; });
    const pending = f.controls.execute('writeConnectionSettings', [f.connected, f.settings], f.context);
    await entered.promise;
    if (invalidation === 'cancel') f.abort.abort(); else f.rebind();
    const closing = invalidation === 'cancel' ? f.controls.close() : null;
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(settled, false);
    resolution.resolve({ serialNumber: f.connected.serialNumber, model: 'pin', bindingGeneration: 3 });
    await assert.rejects(pending, { code: invalidation === 'cancel' ? 'cancelled' : 'identity_mismatch' });
    await (closing ?? f.controls.close());
    assert.deepEqual(f.writes, []);
    f.core.dispose();
  }
});
