import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
let module;
try { module = require('../lib/commonjs/ble/deviceDiagnostics.js'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

function decoder() {
  assert.equal(typeof module?.DeviceDiagnosticsDecoder, 'function');
  return new module.DeviceDiagnosticsDecoder();
}

function fixture() {
  const meta = Buffer.from('900003050045fd0e002a00000000000000', 'hex');
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
    const header = Buffer.from([0x95, 0, offset & 255, offset >> 8, 176, 0]);
    chunks.push(Buffer.concat([header, detail.subarray(offset, offset + 14)]));
  }
  return [meta, signature, ...chunks];
}

test('public diagnostic decoder matches maintenance event and full detail values', () => {
  const value = decoder();
  for (const packet of fixture()) assert.equal(value.push(packet), null);
  const batch = value.push(Buffer.from([0x92, 1]));
  assert.equal(batch.schema_version, 1);
  assert.deepEqual(batch.events, [{
    event_id: '000000000000002a', event_type: 'hard_fault', reason_code: 'cpu_usage_fault',
    uptime_ms: 982341, signature: '0123456789abcdef', firmware_build_id: 'a4f02973d61c',
    subsystem: 'system', state_before_event: 'recording',
    report: {
      fault: { cpu_id: 0, cpu_emu: '00000008', core_emu: '00000000', hsb_emu: '00000000', audio_emu: '00000000', wireless_emu: '00000000' },
      execution: { task: 'btstack', reti: 'sdram:00014bd0', rets: 'ram:000082a4', pc_trace: ['rom:00004118'] },
      runtime: { heap_free_bytes: 18320, task_stack_remaining_bytes: 4096 },
      breadcrumbs: [{ delta_ms: -210, code: 'recording_started', arg0: 2 }],
    },
  }]);
  assert.deepEqual(value.push(Buffer.from([0x92, 0])), { schema_version: 1, events: [] });
});

test('diagnostic decoder rejects incomplete, duplicate and reordered detail with reset', () => {
  const packets = fixture();
  const value = decoder();
  value.push(packets[0]);
  assert.throws(() => value.push(Buffer.from([0x92, 1])), /Incomplete/);
  value.push(packets[2]);
  assert.throws(() => value.push(packets[2]), /Duplicate/);
  assert.throws(() => value.push(packets[3]), /Out-of-order/);
  assert.deepEqual(value.push(Buffer.from([0x92, 0])), { schema_version: 1, events: [] });
});

test('diagnostic acknowledgement keeps all 64 event-ID bits and validates canonical text', () => {
  assert.equal(typeof module?.diagnosticEventIdCommand, 'function');
  assert.equal(module.diagnosticEventIdCommand('0123456789abcdef').toString('hex'), '11efcdab8967452301');
  for (const bad of ['', 'ABC', '0123456789ABCDEF', '00000000000000000']) {
    assert.throws(() => module.diagnosticEventIdCommand(bad), /16 lowercase hex/);
  }
});

test('invalid decoded detail clears state before the next complete batch', () => {
  const value = decoder();
  const bad = fixture();
  bad[2][6] = 2;
  assert.throws(() => { for (const packet of bad) value.push(packet); }, /diagnostic detail/i);
  for (const packet of fixture()) value.push(packet);
  assert.equal(value.push(Buffer.from([0x92, 1])).events[0].event_id, '000000000000002a');
});

test('diagnostic text decoding accepts Hermes-style plain Uint8Array subviews', () => {
  const original = Buffer.prototype.subarray;
  const packets = fixture();
  try {
    Buffer.prototype.subarray = function (start, end) {
      const view = original.call(this, start, end);
      return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    };
    const value = decoder();
    for (const packet of packets) value.push(packet);
    assert.equal(value.push(Buffer.from([0x92, 1])).events[0].firmware_build_id, 'a4f02973d61c');
  } finally {
    Buffer.prototype.subarray = original;
  }
});
