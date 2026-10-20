import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';

const { createBlePlxPort } = loadSource('blePlx.ts');
const context = () => ({ operationId: 'owner', operation: 'ReadStatus', requestId: '1',
  cancellationId: 'captured', generation: '9007199254740993', signal: new AbortController().signal });
const address = { peripheralId: 'device', serviceUuid: 'service', characteristicUuid: 'characteristic' };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('scan merges Android advertisement and scan-response fields by peripheral ID', async () => {
  let scanListener;
  let scanOptions;
  const manager = {
    startDeviceScan(_uuids, options, listener) { scanOptions = options; scanListener = listener; },
    stopDeviceScan() {},
  };
  const candidates = [];
  const port = createBlePlxPort(manager);
  const scan = await port.scan(false, candidate => candidates.push(candidate), context());

  scanListener(null, {
    id: 'note-1', name: null, localName: null, rssi: -51, mtu: 23,
    manufacturerData: Buffer.from([0x7a, 0xb0, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
      1, 2, 0x36, 0x37, 0x4b, 0x50]).toString('base64'),
  });
  scanListener(null, {
    id: 'note-1', name: 'Bota Note', localName: 'Bota Note', rssi: -49, mtu: 23,
    manufacturerData: null,
  });

  assert.deepEqual(scanOptions, { allowDuplicates: true });
  assert.deepEqual(candidates.at(-1), {
    peripheral_id: 'note-1',
    name: 'Bota Note 67KP',
    advertised_address: 'AA:BB:CC:DD:EE:FF',
    rssi: -51,
  });
  assert.deepEqual(port.advertisementMetadata('note-1'), {
    deviceType: 'bota_note', serialSuffix: '67KP',
  });
  await scan.remove();
});

test('unknown and future manufacturer metadata never infer a device model', async () => {
  let scanListener;
  const port = createBlePlxPort({
    startDeviceScan(_uuids, _options, listener) { scanListener = listener; }, stopDeviceScan() {},
  });
  const candidates = [];
  const scan = await port.scan(false, candidate => candidates.push(candidate), context());
  scanListener(null, { id: 'future', name: 'Bota Note FAKE', localName: 'Bota Note FAKE', rssi: -60, mtu: 23,
    manufacturerData: Buffer.from([0x7a, 0xb0, 1, 2, 3, 4, 5, 6, 2, 2, 0x41, 0x42, 0x43, 0x44]).toString('base64') });
  assert.equal(port.advertisementMetadata('future'), undefined);
  assert.equal(candidates[0].name, 'Bota Note FAKE');
  await scan.remove();
});

test('scan and monitor failures reach the exact primitive owner', async () => {
  let scanListener;
  let monitorListener;
  const manager = {
    startDeviceScan(_uuids, _options, listener) { scanListener = listener; }, stopDeviceScan() {},
    cancelTransaction() {},
    monitorCharacteristicForDevice(_id, _service, _characteristic, listener) {
      monitorListener = listener; return { remove() {} };
    },
  };
  const port = createBlePlxPort(manager);
  const failures = [];
  const scan = await port.scan(false, () => assert.fail('failed scan has no candidate'), context(), error => failures.push(error));
  const monitor = await port.subscribe(address, () => assert.fail('failed monitor has no packet'), context(), error => failures.push(error));
  const failedScan = new Error('scan failed');
  const failedMonitor = new Error('monitor failed');
  scanListener(failedScan, null);
  monitorListener(failedMonitor, null);
  assert.deepEqual(failures, [failedScan, failedMonitor]);
  await scan.remove(); await monitor.remove();
  scanListener(new Error('late'), null); monitorListener(new Error('late'), null);
  assert.equal(failures.length, 2);
});

test('failed OS removal remains retryable without restarting the original scan or monitor', async () => {
  let scanStops = 0;
  let monitorStops = 0;
  const port = createBlePlxPort({
    startDeviceScan() {},
    stopDeviceScan() { if (++scanStops === 1) throw new Error('scan uncertain'); },
    monitorCharacteristicForDevice() { return { remove() {} }; },
    cancelTransaction() { if (++monitorStops === 1) throw new Error('monitor uncertain'); },
  });
  const scan = await port.scan(false, () => {}, context());
  const monitor = await port.subscribe(address, () => {}, context());
  await assert.rejects(scan.remove(), error => error.code === 'cleanup_incomplete' && /uncertain/.test(error.cause.message));
  await assert.rejects(monitor.remove(), error => error.code === 'cleanup_incomplete' && /uncertain/.test(error.cause.message));
  await scan.remove(); await monitor.remove();
  await scan.remove(); await monitor.remove();
  assert.equal(scanStops, 2); assert.equal(monitorStops, 2);
});

test('cancelled connect joins its original cancellation and late connection cleanup in order', async () => {
  const connection = deferred(), originalCancellation = deferred(), lateCancellation = deferred();
  const controller = new AbortController();
  const ctx = { ...context(), signal: controller.signal };
  let cancellations = 0, settled = false;
  const port = createBlePlxPort({
    connectToDevice() { return connection.promise; },
    cancelDeviceConnection(id) {
      assert.equal(id, 'device');
      return ++cancellations === 1 ? originalCancellation.promise : lateCancellation.promise;
    },
  });
  const connecting = port.connect('device', ctx);
  const rejected = assert.rejects(connecting, { code: 'cancelled' }).then(() => { settled = true; });
  controller.abort();
  await tick();
  assert.equal(settled, false);
  assert.equal(cancellations, 1);
  originalCancellation.resolve({ id: 'device' });
  await tick();
  assert.equal(settled, false);
  assert.equal(cancellations, 1);
  connection.resolve({ id: 'device' });
  await tick();
  assert.equal(settled, false);
  assert.equal(cancellations, 2);
  lateCancellation.resolve({ id: 'device' });
  await rejected;
});

test('cancellation acknowledged after connect settlement needs no second disconnect', async () => {
  const connection = deferred(), cancellation = deferred();
  const controller = new AbortController();
  let cancellations = 0, settled = false;
  const port = createBlePlxPort({ connectToDevice() { return connection.promise; },
    cancelDeviceConnection() {
      if (++cancellations !== 1) throw new Error('Device already disconnected');
      return cancellation.promise;
    } });
  const connecting = port.connect('device', { ...context(), signal: controller.signal });
  const rejected = assert.rejects(connecting, { code: 'cancelled' }).then(() => { settled = true; });
  controller.abort(); connection.resolve({ id: 'device' });
  await tick();
  assert.equal(settled, false);
  cancellation.resolve({ id: 'device' });
  await rejected;
  assert.equal(cancellations, 1);
});

test('rejected connect still joins its abort-time cancellation before primitive settlement', async () => {
  const connection = deferred(), cancellation = deferred();
  const controller = new AbortController();
  let settled = false, cancellations = 0;
  const port = createBlePlxPort({ connectToDevice() { return connection.promise; },
    cancelDeviceConnection() { cancellations++; return cancellation.promise; } });
  const connecting = port.connect('device', { ...context(), signal: controller.signal });
  const rejected = assert.rejects(connecting).then(() => { settled = true; });
  controller.abort(); connection.reject(new Error('Connection cancelled'));
  await tick();
  assert.equal(settled, false);
  cancellation.resolve({ id: 'device' });
  await rejected;
  assert.equal(cancellations, 1);
});

test('a throwing abort-time cancellation is joined and preserves the exact target for final disconnect', async () => {
  const connection = deferred();
  const controller = new AbortController();
  const failure = new Error('Cancellation uncertainty');
  let cancellations = 0;
  const port = createBlePlxPort({ connectToDevice() { return connection.promise; },
    cancelDeviceConnection(id) {
      assert.equal(id, 'device');
      if (++cancellations === 1) throw failure;
      return Promise.resolve({ id });
    } });
  const connecting = port.connect('device', { ...context(), signal: controller.signal });
  const rejected = assert.rejects(connecting, error => error.code === 'cleanup_incomplete' && error.cause === failure);
  controller.abort(); connection.reject(new Error('Connect cancelled'));
  await rejected;
  await port.disconnect('device', context());
  assert.equal(cancellations, 2);
});

test('failed late connection cleanup retains its target and surfaces cleanup uncertainty', async () => {
  const connection = deferred();
  const controller = new AbortController();
  const failure = new Error('Late disconnect uncertainty');
  let cancellations = 0;
  const port = createBlePlxPort({ connectToDevice() { return connection.promise; },
    cancelDeviceConnection(id) {
      assert.equal(id, 'device');
      if (++cancellations === 2) return Promise.reject(failure);
      return Promise.resolve({ id });
    } });
  const connecting = port.connect('device', { ...context(), signal: controller.signal });
  const rejected = assert.rejects(connecting, error => error.code === 'cleanup_incomplete' && error.cause === failure);
  controller.abort(); connection.resolve({ id: 'device' });
  await rejected;
  await port.disconnect('device', context());
  assert.equal(cancellations, 3);
});

test('throwing transaction cancellation cannot escape abort or settle before the submitted read', async () => {
  const read = deferred();
  const controller = new AbortController();
  const failure = new Error('Transaction cancellation uncertainty');
  let settled = false;
  const port = createBlePlxPort({ readCharacteristicForDevice() { return read.promise; },
    cancelTransaction() { throw failure; } });
  const reading = port.read(address, { ...context(), signal: controller.signal });
  const rejected = assert.rejects(reading, error => error.code === 'cleanup_incomplete' && error.cause === failure)
    .then(() => { settled = true; });
  controller.abort();
  await tick();
  assert.equal(settled, false);
  read.resolve({ value: 'AQ==' });
  await rejected;
});

test('a submitted read joins asynchronous transaction cancellation before returning', async () => {
  const read = deferred(), cancellation = deferred();
  const controller = new AbortController();
  let settled = false;
  const port = createBlePlxPort({ readCharacteristicForDevice() { return read.promise; },
    cancelTransaction() { return cancellation.promise; } });
  const reading = port.read(address, { ...context(), signal: controller.signal });
  const rejected = assert.rejects(reading, { code: 'cancelled' }).then(() => { settled = true; });
  controller.abort(); read.resolve({ value: 'AQ==' });
  await tick();
  assert.equal(settled, false);
  cancellation.resolve();
  await rejected;
});

test('a rejected asynchronous transaction cancellation reports cleanup uncertainty after read settlement', async () => {
  const read = deferred(), cancellation = deferred();
  const controller = new AbortController();
  const failure = new Error('Async transaction cancellation uncertainty');
  const port = createBlePlxPort({ readCharacteristicForDevice() { return read.promise; },
    cancelTransaction() { return cancellation.promise; } });
  const reading = port.read(address, { ...context(), signal: controller.signal });
  const rejected = assert.rejects(reading, error => error.code === 'cleanup_incomplete' && error.cause === failure);
  controller.abort(); cancellation.reject(failure);
  await tick();
  read.reject(new Error('Read cancelled'));
  await rejected;
});

test('scan abort joins actual startup and stop and blocks a replacement scan until both settle', async () => {
  const startup = deferred(), stopping = deferred();
  const controller = new AbortController();
  let starts = 0, stops = 0, settled = false;
  const port = createBlePlxPort({ startDeviceScan() { starts++; return startup.promise; },
    stopDeviceScan() { stops++; return stopping.promise; } });
  const scanning = port.scan(false, () => {}, { ...context(), signal: controller.signal });
  const rejected = assert.rejects(scanning, { code: 'cancelled' }).then(() => { settled = true; });
  await tick();
  assert.equal(starts, 1);
  controller.abort();
  await tick();
  assert.equal(stops, 0);
  assert.equal(settled, false);
  await assert.rejects(port.scan(false, () => {}, context()));
  startup.resolve();
  await tick();
  assert.equal(stops, 1);
  assert.equal(settled, false);
  await assert.rejects(port.scan(false, () => {}, context()));
  stopping.resolve();
  await rejected;
  const replacement = await port.scan(false, () => {}, context());
  await replacement.remove();
});

test('monitor removal joins the public transaction cancellation once and suppresses late packets', async () => {
  const cancellation = deferred();
  const controller = new AbortController();
  let notify, cancellations = 0, settled = false;
  const port = createBlePlxPort({ monitorCharacteristicForDevice(_id, _service, _characteristic, callback) {
    notify = callback; return { remove() {} };
  }, cancelTransaction() { cancellations++; return cancellation.promise; } });
  const subscription = await port.subscribe(address, () => assert.fail('Late packet'),
    { ...context(), signal: controller.signal });
  controller.abort();
  const removal = subscription.remove().then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  assert.equal(cancellations, 1);
  notify(null, { value: 'AQ==' });
  cancellation.resolve();
  await removal;
  await subscription.remove();
  assert.equal(cancellations, 1);
});

test('failed scan startup retains its owner until the actual OS stop acknowledges cleanup', async () => {
  const startup = deferred(), stopping = deferred();
  const failure = new Error('Scan startup failed');
  let settled = false, stops = 0;
  const port = createBlePlxPort({ startDeviceScan() { return startup.promise; },
    stopDeviceScan() { stops++; return stopping.promise; } });
  const scanning = port.scan(false, () => {}, context());
  const rejected = assert.rejects(scanning, error => error === failure).then(() => { settled = true; });
  startup.reject(failure);
  await tick();
  assert.equal(stops, 1);
  assert.equal(settled, false);
  await assert.rejects(port.scan(false, () => {}, context()));
  stopping.resolve();
  await rejected;
});

test('failed asynchronous scan stop is retained, reported and retryable without escaping the abort observer', async () => {
  const stopping = deferred();
  const controller = new AbortController();
  const failure = new Error('Scan stop uncertainty');
  const reported = [];
  let stops = 0;
  const port = createBlePlxPort({ async startDeviceScan() {},
    stopDeviceScan() { return ++stops === 1 ? stopping.promise : Promise.resolve(); } });
  const subscription = await port.scan(false, () => {}, { ...context(), signal: controller.signal }, error => {
    reported.push(error); throw new Error('Application observer failed');
  });
  controller.abort();
  const removal = subscription.remove();
  assert.equal(subscription.remove(), removal);
  const rejected = assert.rejects(removal, error => error.code === 'cleanup_incomplete' && error.cause === failure);
  await tick();
  assert.equal(stops, 1);
  stopping.reject(failure);
  await rejected;
  await tick();
  assert.equal(reported.length, 1);
  assert.equal(reported[0].code, 'cleanup_incomplete');
  await assert.rejects(port.scan(false, () => {}, context()));
  await subscription.remove();
  const replacement = await port.scan(false, () => {}, context());
  await replacement.remove();
  assert.equal(stops, 3);
});

test('a retired disconnect observer cannot clear a replacement using the same OS ID', async () => {
  const observers = [], oldReports = [], newReports = [];
  let connections = 0, discoveries = 0, removals = 0, current;
  const peripheral = mtu => ({ id: 'device', name: null, rssi: -50, mtu,
    async discoverAllServicesAndCharacteristics() { discoveries++; return peripheral(mtu); } });
  const port = createBlePlxPort({
    async connectToDevice() { return current = peripheral(++connections === 1 ? 247 : 185); },
    async requestMTUForDevice(id) { assert.equal(id, 'device'); return current; },
    onDeviceDisconnected(id, callback) {
      assert.equal(id, 'device'); observers.push(callback);
      return { remove() { removals++; } };
    },
  });
  await port.connect('device', context());
  const oldObserver = await port.observeDisconnect('device', error => oldReports.push(error), context());
  await port.discoverServices('device', context());
  await port.connect('device', context());
  await port.discoverServices('device', context());
  const newObserver = await port.observeDisconnect('device', error => newReports.push(error), context());
  observers[0](new Error('Old physical link'), peripheral(247));
  assert.deepEqual(oldReports, []);
  assert.equal(await port.getMtu('device', context()), 185);
  await port.discoverServices('device', context());
  assert.equal(discoveries, 3);
  assert.equal(await port.getMtu('device', context()), 185);
  // Discovery returns a new object while the physical connection is unchanged.
  observers[1](new Error('Current physical link'), null);
  assert.deepEqual(newReports, ['Current physical link']);
  await assert.rejects(port.getMtu('device', context()), /no local connection/);
  await assert.rejects(port.discoverServices('device', context()), /no local connection/);
  await oldObserver.remove(); await newObserver.remove();
  assert.equal(removals, 2);
});

test('the real generated BLE policy requests canonical MTU and observes negotiation instead of cached 23', async () => {
  let requested, observations = 0, freshDiscoveries = 0;
  const fresh = { id: 'device', mtu: 512, async discoverAllServicesAndCharacteristics() {
    freshDiscoveries++; return fresh;
  } };
  const port = createBlePlxPort({
    async connectToDevice(id, options) { assert.equal(id, 'device'); requested = options.requestMTU; return { id, mtu: 23 }; },
    async requestMTUForDevice(id) {
      assert.equal(id, 'device');
      return ++observations === 1 ? { id: 'device', mtu: 23 } : fresh;
    },
  });
  await port.connect('device', context());
  assert.equal(requested, 512);
  assert.equal(await port.getMtu('device', context()), 512);
  assert.equal(observations, 2);
  await port.discoverServices('device', context());
  assert.equal(freshDiscoveries, 1);
});

test('MTU observation refuses a foreign peripheral before changing the captured connection', async () => {
  const port = createBlePlxPort({ async connectToDevice() { return { id: 'device', mtu: 23 }; },
    async requestMTUForDevice() { return { id: 'other', mtu: 512 }; } });
  await port.connect('device', context());
  await assert.rejects(port.getMtu('device', context()), { code: 'identity_mismatch' });
});

test('Android MTU observation uses the connected request result rather than the scan cache', async () => {
  let requests = 0;
  const port = createBlePlxPort({
    async connectToDevice() { return { id: 'device', mtu: 512 }; },
    async devices() { return [{ id: 'device', mtu: null }]; },
    async requestMTUForDevice(id, mtu, transactionId) {
      assert.equal(id, 'device');
      assert.equal(mtu, 512);
      assert.match(transactionId, /^bota:/);
      requests++;
      return { id, mtu: 512 };
    },
  });
  await port.connect('device', context());
  assert.equal(await port.getMtu('device', context()), 512);
  assert.equal(requests, 1);
});

test('a captured MTU observation cannot replace the same-ID connection after its physical generation changes', async () => {
  const observation = deferred();
  let connections = 0, observations = 0;
  const port = createBlePlxPort({ async connectToDevice() { return { id: 'device', mtu: ++connections === 1 ? 23 : 512 }; },
    async requestMTUForDevice() { return ++observations === 1 ? observation.promise : { id: 'device', mtu: 512 }; } });
  await port.connect('device', context());
  const pending = port.getMtu('device', context());
  const rejected = assert.rejects(pending, { code: 'identity_mismatch' });
  await port.connect('device', context());
  observation.resolve({ id: 'device', mtu: 247 });
  await rejected;
  assert.equal(await port.getMtu('device', context()), 512);
});

test('cancellation joins the already submitted MTU observation and performs no retry', async () => {
  const observation = deferred(), cancellation = deferred();
  const controller = new AbortController();
  let observations = 0, cancellations = 0, settled = false;
  const port = createBlePlxPort({ async connectToDevice() { return { id: 'device', mtu: 23 }; },
    requestMTUForDevice(_id, _mtu, transactionId) {
      assert.match(transactionId, /^bota:/); observations++; return observation.promise;
    },
    cancelTransaction(transactionId) {
      assert.match(transactionId, /^bota:/); cancellations++; return cancellation.promise;
    } });
  await port.connect('device', context());
  const pending = port.getMtu('device', { ...context(), signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'cancelled' }).then(() => { settled = true; });
  controller.abort();
  await tick();
  assert.equal(settled, false);
  observation.resolve({ id: 'device', mtu: 23 });
  await tick();
  assert.equal(settled, false);
  assert.equal(cancellations, 1);
  cancellation.resolve();
  await rejected;
  assert.equal(observations, 1);
});

test('abort during the Rust-declared MTU observation pause clears its timer without another OS call', async () => {
  const controller = new AbortController();
  let observations = 0;
  const port = createBlePlxPort({ async connectToDevice() { return { id: 'device', mtu: 23 }; },
    async requestMTUForDevice() { observations++; return { id: 'device', mtu: 23 }; } });
  await port.connect('device', context());
  const pending = port.getMtu('device', { ...context(), signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'cancelled' });
  await tick();
  controller.abort();
  await rejected;
  assert.equal(observations, 1);
});

test('MTU observations stop at the shared ten-attempt limit and return the last actual capacity', { timeout: 5000 }, async () => {
  let observations = 0;
  const port = createBlePlxPort({ async connectToDevice() { return { id: 'device', mtu: 512 }; },
    async requestMTUForDevice() { observations++; return { id: 'device', mtu: 23 }; } });
  await port.connect('device', context());
  assert.equal(await port.getMtu('device', context()), 23);
  assert.equal(observations, 10);
});

test('generic OS state observation joins removal and state reads without hidden emit-current jobs', async () => {
  const controller = new AbortController();
  const state = deferred(), removal = deferred();
  let callback, removals = 0, removed = false;
  const values = [];
  const port = createBlePlxPort({ state() { return state.promise; },
    onStateChange(onState, emitCurrent) {
      assert.equal(emitCurrent, false); callback = onState;
      return { remove() { removals++; return removal.promise; } };
    } });
  const ctx = { ...context(), signal: controller.signal };
  const subscription = await port.observeBluetoothState(value => values.push(value), ctx);
  callback('PoweredOff'); assert.deepEqual(values, ['PoweredOff']);
  const reading = port.readBluetoothState(ctx);
  const rejected = assert.rejects(reading, { code: 'cancelled' });
  controller.abort();
  const disposing = subscription.remove().then(() => { removed = true; });
  await tick();
  callback('PoweredOn'); assert.deepEqual(values, ['PoweredOff']);
  assert.equal(removed, false);
  state.resolve('PoweredOn'); await rejected;
  removal.resolve(); await disposing;
  assert.equal(removals, 1);
});
