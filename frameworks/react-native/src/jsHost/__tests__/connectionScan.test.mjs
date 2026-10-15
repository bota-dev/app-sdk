import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';

const { BotaJsHostExecutor } = loadSource('executor.ts');
const { createGeneratedJsCore } = loadSource('core.ts');

test('generated reconnect ignores exact queued scan callbacks only until StopScan settles', () => {
  const core = createGeneratedJsCore();
  try {
    for (const stopOnMatch of [true, false]) {
      const engine = core.createEngine();
      const identity = { version: 1, generation: '1', operation: 'Reconnect', cancellation_id: Array(16).fill(1) };
      const request = input => {
        const response = engine.request({ ...identity, ...input });
        assert.equal(response.ok, true, JSON.stringify(response));
        return response.result.effects;
      };
      const dispatch = (effect, kind) => request({ action: 'dispatch', event: { request_id: effect.request_id, kind } });
      const exact = { peripheral_id: 'exact-peripheral', name: 'Bota Pin', advertised_address: null, rssi: -42 };
      const started = request({ action: 'start', capabilities: ['Ble', 'Timer', 'Persistence'],
        command: { Reconnect: { device: 'C8SU2XXWHI', hint: {
          stored_peripheral_id: exact.peripheral_id, advertised_address: null, stored_name: 'Bota Pin',
          scan_timeout_ms: '1000', connection_timeout_ms: '10000',
        } } } });
      const scan = started.find(value => value.effect.Ble?.StartScan);
      const timer = started.find(value => value.effect.Timer?.Schedule);
      if (!stopOnMatch) dispatch(scan, { Ble: { ScanResult: { candidate: { ...exact, peripheral_id: 'same-name-probe' } } } });
      const stopping = stopOnMatch
        ? dispatch(scan, { Ble: { ScanResult: { candidate: exact } } })
        : dispatch(timer, { TimerFired: { timer_id: timer.effect.Timer.Schedule.timer_id } });
      // A callback queued before native scan removal may still arrive while
      // StopScan is pending. It must not change the already selected candidate.
      assert.deepEqual(dispatch(scan, { Ble: { ScanResult: {
        candidate: { ...exact, peripheral_id: 'late-peripheral', rssi: -1 },
      } } }), []);
      const stop = stopping.find(value => value.effect.Ble === 'StopScan');
      const connecting = dispatch(stop, { Ble: 'ScanStopped' });
      const connect = connecting.find(value => value.effect.Ble?.Connect);
      const expectedId = stopOnMatch ? exact.peripheral_id : 'same-name-probe';
      assert.equal(connect.effect.Ble.Connect.peripheral_id, expectedId);
      assert.equal(connecting.some(value => value.effect.Persistence?.SaveConnectionIdentity), false);
      const discovering = dispatch(connect, { Ble: { Connected: { peripheral_id: expectedId } } });
      const discover = discovering.find(value => value.effect.Ble?.DiscoverServices);
      const reading = dispatch(discover, { Ble: { ServicesDiscovered: { peripheral_id: expectedId } } });
      const read = reading.find(value => value.effect.Ble?.Read);
      assert.equal(read.effect.Ble.Read.characteristic_uuid, '2A25');
      const persisting = dispatch(read, { Ble: { ReadCompleted: { value: [...Buffer.from('C8SU2XXWHI')] } } });
      assert.ok(persisting.some(value => value.effect.Persistence?.SaveConnectionIdentity));
      engine.dispose();
    }
  } finally { core.dispose(); }
});

test('StopScan joins the exact scan startup before acknowledging removal or admitting Connect', { timeout: 5000 }, async () => {
  let release, entered;
  const startup = new Promise(resolve => { release = resolve; });
  const scanning = new Promise(resolve => { entered = resolve; });
  let removed = 0, acknowledged = 0, connected = 0, scanRequest;
  let next = 1;
  let identity;
  const effect = value => ({ request_id: String(next++), operation: identity.operation,
    cancellation_id: identity.cancellation_id, effect: value });
  const running = { Running: { operation: 'Reconnect' } };
  const core = { codec() { throw new Error('No codec expected'); }, createEngine() {
    return { dispose() {}, request(input) {
      identity = input;
      if (input.action === 'start') {
        const request = effect({ Ble: { StartScan: { allow_duplicates: true } } });
        scanRequest = request.request_id;
        return { ok: true, result: { status: running, effects: [request] } };
      }
      if (input.action === 'cancel') return { ok: true, result: {
        status: { Cancelled: { operation: 'Reconnect' } }, effects: [],
      } };
      const event = input.event.kind.Ble;
      if (event.ScanResult) {
        assert.equal(input.event.request_id, scanRequest);
        return { ok: true, result: { status: running,
          effects: [effect({ Ble: 'StopScan' })] } };
      }
      if (event === 'ScanStopped') {
        acknowledged++;
        assert.equal(removed, 1, 'scan removal must settle before ScanStopped');
        return { ok: true, result: { status: running,
          effects: [effect({ Ble: { Connect: { peripheral_id: 'exact-peripheral' } } })] } };
      }
      assert.deepEqual(event, { Connected: { peripheral_id: 'exact-peripheral' } });
      return { ok: true, result: { status: { Completed: { operation: 'Reconnect' } }, effects: [] } };
    } };
  } };
  const ports = { platform: 'test', randomBytes: () => new Uint8Array(16),
    persistence: { namespace: 'account/project/user', async load() { return null; }, async save() {}, async remove() {} },
    ble: {
      async scan(_duplicates, callback) {
        // BLE libraries can synchronously deliver an already cached candidate
        // while their asynchronous scan-registration promise is still pending.
        callback({ peripheral_id: 'exact-peripheral', name: 'Bota Pin', advertised_address: null, rssi: -40 });
        entered();
        await startup;
        return { async remove() { removed++; } };
      },
      async connect() { assert.equal(removed, 1); connected++; },
      async disconnect() {}, async discoverServices() {}, async read() { return new Uint8Array(); },
      async write() {}, async subscribe() { return { async remove() {} }; },
    },
  };
  const executor = new BotaJsHostExecutor(core, ports);
  const result = executor.run({}, { operation: 'Reconnect' });
  void result.catch(() => {});
  try {
    await scanning;
    assert.equal(acknowledged, 0, 'StopScan must await the pending scan registration');
    assert.equal(connected, 0);
    release();
    await result;
    assert.equal(acknowledged, 1);
    assert.equal(removed, 1);
    assert.equal(connected, 1);
  } finally {
    release();
    await result.catch(() => {});
    await executor.destroy();
  }
});
