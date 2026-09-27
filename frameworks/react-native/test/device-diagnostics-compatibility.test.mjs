import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';

const require = createRequire(import.meta.url);
const { DeviceManager } = require('../lib/commonjs/managers/DeviceManager.js');
const { createBotaDeviceSDK } = require('../lib/commonjs/client.js');
const { setCompatibilityClientForTesting } = require('../lib/commonjs/compatibility/runtime.js');

afterEach(() => setCompatibilityClientForTesting(null));

const device = {
  id: 'peripheral', serialNumber: 'TESTSERIAL', deviceType: 'bota_note',
  firmwareVersion: '1.0.17', isProvisioned: true, connectionState: 'connected', mtu: 247,
};
const batch = { schema_version: 1, events: [] };

test('diagnostic methods delegate bounded metadata to the native device owner', async () => {
  const calls = [];
  const native = {
    readDiagnosticEvents: async (selected) => { calls.push(['read', selected.id]); return batch; },
    acknowledgeDiagnosticEvents: async (selected, ids) => { calls.push(['ack', selected.id, ids]); },
  };
  const client = createBotaDeviceSDK(native);
  assert.equal(typeof client.logs.readDiagnosticEvents, 'function');
  assert.deepEqual(await client.logs.readDiagnosticEvents(device), batch);
  await client.logs.acknowledgeDiagnosticEvents(device, ['0123456789abcdef']);
  assert.deepEqual(calls, [['read', 'peripheral'], ['ack', 'peripheral', ['0123456789abcdef']]]);
});

test('compatibility manager exposes diagnostics without implicitly acknowledging events', async () => {
  let acknowledgements = 0;
  setCompatibilityClientForTesting({
    devices: { connect: async () => device },
    logs: {
      readDiagnosticEvents: async () => batch,
      acknowledgeDiagnosticEvents: async () => { acknowledgements++; },
    },
  });
  const manager = new DeviceManager();
  await manager.connect(device);
  assert.equal(typeof manager.readDiagnosticEvents, 'function');
  assert.deepEqual(await manager.readDiagnosticEvents(device), batch);
  assert.equal(acknowledgements, 0);
  await manager.acknowledgeDiagnosticEvents(device, ['000000000000002a']);
  assert.equal(acknowledgements, 1);
  manager.destroy();
});

test('all diagnostic IDs are validated before the native acknowledgement call', async () => {
  let writes = 0;
  const client = createBotaDeviceSDK({
    acknowledgeDiagnosticEvents: async () => { writes++; },
  });
  assert.equal(typeof client.logs.acknowledgeDiagnosticEvents, 'function');
  await assert.rejects(client.logs.acknowledgeDiagnosticEvents(device, ['000000000000002a', 'ABC']), /16 lowercase hex/);
  assert.equal(writes, 0);
});

test('diagnostic bridge preserves nested optional reports and numeric boundaries', async () => {
  const event = {
    event_id: 'ffffffffffffffff', event_type: 'hard_fault', reason_code: 'cpu_usage_fault',
    uptime_ms: 4294967295, signature: '0123456789abcdef', firmware_build_id: 'a4f02973d61c',
    subsystem: 'system', state_before_event: 'recording',
  };
  const fault = { cpu_id: 0, cpu_emu: '00000000', core_emu: '00000000', hsb_emu: '00000000', audio_emu: '00000000', wireless_emu: '00000000' };
  for (const report of [undefined, { fault, execution: { pc_trace: [] } }, {
    fault, execution: { task: 'btstack', reti: 'rom:00000001', pc_trace: ['rom:00000001'] },
    runtime: { heap_free_bytes: 0, task_stack_remaining_bytes: 4294967295 },
    breadcrumbs: [{ delta_ms: -2147483648, code: 'recording_started', arg0: 2147483647 }],
  }]) {
    const expected = { ...event, ...(report ? { report } : {}) };
    const client = createBotaDeviceSDK({ readDiagnosticEvents: async () => ({ schema_version: 1, events: [expected] }) });
    assert.deepEqual((await client.logs.readDiagnosticEvents(device)).events, [expected]);
  }
});
