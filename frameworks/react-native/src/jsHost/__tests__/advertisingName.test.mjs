import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';

const { createGeneratedJsCore } = loadSource('core.ts');

test('generated reconnect bridges renamed advertisements and rejects a colliding SN tail', () => {
  const core = createGeneratedJsCore();
  try {
    for (const [stored, advertised] of [
      ['Bota Pin', 'Bota Pin 67KP'],
      ['Bota Pin 67KP', 'Bota Pin'],
      ['Customer Name', 'Bota Pin 67KP'],
    ]) {
      const engine = core.createEngine();
      try {
        const identity = { version: 1, generation: '1', operation: 'Reconnect', cancellation_id: Array(16).fill(1) };
        const request = input => {
          const response = engine.request({ ...identity, ...input });
          assert.equal(response.ok, true, JSON.stringify(response));
          return response.result.effects;
        };
        const dispatch = (effect, kind) => request({ action: 'dispatch', event: { request_id: effect.request_id, kind } });
        const started = request({ action: 'start', capabilities: ['Ble', 'Timer', 'Persistence'],
          command: { Reconnect: { device: 'EVFXXW67KP', hint: {
            stored_peripheral_id: null, advertised_address: null, stored_name: stored,
            scan_timeout_ms: '1000', connection_timeout_ms: '10000',
          } } } });
        const scan = started.find(value => value.effect.Ble?.StartScan);
        for (const [id, name, rssi] of [
          ['wrong-tail', 'Bota Pin 0000', -5], ['collision', advertised, -20], ['target', advertised, -30],
        ]) dispatch(scan, { Ble: { ScanResult: { candidate: {
          peripheral_id: id, name, advertised_address: null, rssi,
        } } } });
        const timer = started.find(value => value.effect.Timer?.Schedule);
        const stopping = dispatch(timer, { TimerFired: { timer_id: timer.effect.Timer.Schedule.timer_id } });
        const connecting = dispatch(stopping.find(value => value.effect.Ble === 'StopScan'), { Ble: 'ScanStopped' });
        const readSerial = (effects, id, serial) => {
          assert.equal(effects.some(value => value.effect.Persistence?.SaveConnectionIdentity), false);
          const connect = effects.find(value => value.effect.Ble?.Connect);
          assert.ok(connect, `Expected a probe for ${stored} -> ${advertised}`);
          assert.equal(connect.effect.Ble.Connect.peripheral_id, id);
          const discovering = dispatch(connect, { Ble: { Connected: { peripheral_id: id } } });
          const reading = dispatch(discovering.find(value => value.effect.Ble?.DiscoverServices),
            { Ble: { ServicesDiscovered: { peripheral_id: id } } });
          return dispatch(reading.find(value => value.effect.Ble?.Read),
            { Ble: { ReadCompleted: { value: [...Buffer.from(serial)] } } });
        };
        const rejected = readSerial(connecting, 'collision', 'OTHERX67KP');
        assert.equal(rejected.some(value => value.effect.Persistence?.SaveConnectionIdentity), false);
        const next = dispatch(rejected.find(value => value.effect.Ble?.Disconnect),
          { Ble: { Disconnected: { peripheral_id: 'collision', reason_code: null } } });
        const accepted = readSerial(next, 'target', 'EVFXXW67KP');
        assert.ok(accepted.some(value => value.effect.Persistence?.SaveConnectionIdentity));
      } finally { engine.dispose(); }
    }
  } finally { core.dispose(); }
});
