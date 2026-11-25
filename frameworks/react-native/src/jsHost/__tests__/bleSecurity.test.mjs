import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';

const { createSecureBlePlxPort } = loadSource('bleSecurity.ts');
const context = () => ({ operationId: 'connect', operation: 'Connect', requestId: '1',
  cancellationId: 'owner', generation: '1', signal: new AbortController().signal });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(platform = 'ios', timeoutMs = 60_000) {
  const calls = [], losses = [];
  let value = [1, 1, 16, 0];
  let read = async () => ({ value: Buffer.from(value).toString('base64') });
  let bond = async () => {};
  const device = { id: 'device', mtu: 247, async discoverAllServicesAndCharacteristics() { return this; } };
  const manager = {
    async connectToDevice() { calls.push('connect'); return device; },
    async cancelDeviceConnection() { calls.push('disconnect'); return device; },
    onDeviceDisconnected(_id, listener) { losses.push(listener); return { remove() {} }; },
    async readCharacteristicForDevice(_id, _service, characteristic) { calls.push(['read', characteristic]); return read(); },
    async writeCharacteristicWithResponseForDevice() { calls.push('write'); },
    async cancelTransaction() { calls.push('cancel-read'); },
  };
  const bonding = {
    ensureBond(id, request, timeout) { calls.push(['bond', id, request, timeout]); return bond(); },
    async cancelBond(request) { calls.push(['cancel-bond', request]); },
  };
  const port = createSecureBlePlxPort(manager, { platform, bonding, timeoutMs });
  const address = { peripheralId: 'device', serviceUuid: 'business', characteristicUuid: 'command' };
  return { port, calls, losses, address, manager, setValue(v) { value = v; }, setRead(f) { read = f; }, setBond(f) { bond = f; } };
}

test('Android waits for bond and a fresh encrypted read before allowing business writes', async () => {
  const f = fixture('android'), ctx = context(), gate = deferred();
  f.setBond(() => gate.promise);
  await f.port.connect('device', ctx);
  await assert.rejects(f.port.write(f.address, Uint8Array.of(5), true, ctx), { code: 'ble_security_required' });
  const pending = f.port.ensureSecure('device', ctx);
  await tick();
  assert.equal(f.calls.some(c => Array.isArray(c) && c[0] === 'read'), false);
  gate.resolve(); await pending;
  await f.port.write(f.address, Uint8Array.of(5), true, ctx);
  assert.equal(f.calls.at(-1), 'write');
  assert(f.calls.some(c => Array.isArray(c) && c[0] === 'read' && c[1].toLowerCase() === 'b07a0005-0005-1000-8000-00805f9b34fb'));
});

for (const bytes of [[1, 0, 16, 0], [1, 1, 7, 0], [2, 1, 16, 0], [1, 1, 16], [1, 1, 16, 1]]) {
  test(`rejects invalid security proof ${bytes} without allowing business writes`, async () => {
    const f = fixture(), ctx = context(); f.setValue(bytes);
    await f.port.connect('device', ctx);
    await assert.rejects(f.port.ensureSecure('device', ctx), { code: 'ble_security_failed' });
    await assert.rejects(f.port.write(f.address, Uint8Array.of(5), true, ctx), { code: 'ble_security_required' });
    assert(!f.calls.includes('write'));
  });
}
test('iOS reads the protected characteristic without calling an Android bridge', async () => {
  const f = fixture(), ctx = context(); await f.port.connect('device', ctx);
  await f.port.ensureSecure('device', ctx);
  assert(!f.calls.some(c => Array.isArray(c) && c[0] === 'bond'));
});
for (const errorCode of [302, 404]) {
  test(`missing security endpoint (${errorCode}) requires firmware upgrade without a downgrade`, async () => {
    const f = fixture(), ctx = context(); f.setRead(async () => { throw { errorCode }; });
    await f.port.connect('device', ctx);
    await assert.rejects(f.port.ensureSecure('device', ctx), {
      code: 'ble_security_firmware_required',
      message: 'This device lacks Bluetooth security support. Update its firmware before connecting.',
    });
    await assert.rejects(f.port.write(f.address, Uint8Array.of(5), true, ctx));
    assert(!f.calls.includes('write'));
  });
}
test('a transport read failure is not misreported as unsupported firmware', async () => {
  const f = fixture(), ctx = context(); f.setRead(async () => { throw { errorCode: 401 }; });
  await f.port.connect('device', ctx);
  await assert.rejects(f.port.ensureSecure('device', ctx), { code: 'ble_security_failed' });
  await assert.rejects(f.port.write(f.address, Uint8Array.of(5), true, ctx));
});
test('user refusal retains an actionable pairing error', async () => {
  const f = fixture('android'), ctx = context();
  f.setBond(async () => { throw Object.assign(new Error('private detail'), { code: 'ble_pairing_rejected' }); });
  await f.port.connect('device', ctx);
  await assert.rejects(f.port.ensureSecure('device', ctx), { code: 'ble_pairing_rejected', message: 'Bluetooth pairing did not complete.' });
  assert(!f.calls.some(c => Array.isArray(c) && c[0] === 'read'));
});
for (const cancelledBy of ['caller', 'timeout', 'disconnect']) {
  test(`${cancelledBy} cancels and joins submitted work; late success cannot admit the link`, async () => {
    const f = fixture('ios', cancelledBy === 'timeout' ? 10 : 60_000), controller = new AbortController();
    const ctx = { ...context(), signal: controller.signal }, gate = deferred(), cancellation = deferred();
    f.setRead(() => gate.promise);
    f.manager.cancelTransaction = async () => { cancellation.resolve(); };
    await f.port.connect('device', ctx);
    let settled = false;
    const pending = f.port.ensureSecure('device', ctx).finally(() => { settled = true; });
    const rejected = assert.rejects(pending, { code: cancelledBy === 'timeout' ? 'ble_security_timeout' : 'cancelled' });
    await tick();
    if (cancelledBy === 'caller') controller.abort();
    if (cancelledBy === 'disconnect') f.losses[0](null, null);
    await cancellation.promise; await tick();
    assert.equal(settled, false, 'owner is held until native IO settles');
    gate.resolve({ value: Buffer.from([1, 1, 16, 0]).toString('base64') }); await rejected;
    await assert.rejects(f.port.write(f.address, Uint8Array.of(5), true, context()));
  });
}
test('cancelling Android pairing cancels only its request and joins the native promise', async () => {
  const f = fixture('android'), controller = new AbortController(), gate = deferred();
  const ctx = { ...context(), signal: controller.signal };
  f.setBond(() => gate.promise);
  // Successful cancel completes the native request, just as the handler bridge does.
  const bridge = { ensureBond: () => gate.promise, async cancelBond(id) { f.calls.push(['cancel', id]); gate.resolve(); } };
  const { createSecureBlePlxPort } = loadSource('bleSecurity.ts');
  const port = createSecureBlePlxPort(f.manager, { platform: 'android', bonding: bridge });
  await port.connect('device', ctx);
  const pending = port.ensureSecure('device', ctx); controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(f.calls.filter(c => c[0] === 'cancel').length, 1);
  assert(!f.calls.some(c => Array.isArray(c) && c[0] === 'read'));
});
test('reconnect needs a fresh proof and ignores the old connection observer', async () => {
  const f = fixture(), ctx = context(); await f.port.connect('device', ctx);
  await f.port.ensureSecure('device', ctx); const oldLoss = f.losses[0];
  await f.port.disconnect('device', ctx); await f.port.connect('device', ctx);
  await assert.rejects(f.port.write(f.address, Uint8Array.of(5), true, ctx));
  await f.port.ensureSecure('device', ctx); oldLoss(null, null);
  await f.port.write(f.address, Uint8Array.of(5), true, ctx);
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 2);
});
test('only the standard public serial endpoint is readable before security admission', async () => {
  const f = fixture(), ctx = context(); await f.port.connect('device', ctx);
  await f.port.read({ ...f.address, serviceUuid: '180a', characteristicUuid: '2a25' }, ctx);
  await assert.rejects(f.port.read({ ...f.address, characteristicUuid: '2a25' }, ctx));
  await assert.rejects(f.port.read(f.address, ctx));
});
test('missing Android native bridge permits discovery but refuses connection before OS access', async () => {
  const f = fixture(), candidates = [];
  f.manager.startDeviceScan = (_services, _options, callback) => {
    f.calls.push('scan'); callback(null, { id: 'legacy', localName: 'BOTA_DEV' });
  };
  f.manager.stopDeviceScan = () => { f.calls.push('stop-scan'); };
  const port = createSecureBlePlxPort(f.manager, { platform: 'android' });
  const scan = await port.scan(false, value => candidates.push(value), context());
  assert.equal(candidates[0].peripheral_id, 'legacy');
  await scan.remove();
  await assert.rejects(port.connect('device', context()), { code: 'ble_security_unavailable' });
  assert.deepEqual(f.calls, ['scan', 'stop-scan']);
});

for (const platform of ['android', 'ios']) {
  test(platform + ' waits for native disconnect and preserves the observer when the link stays up', async () => {
    const f = fixture(platform), ctx = context(), events = [];
    await f.port.connect('device', ctx);
    await f.port.ensureSecure('device', ctx);
    await f.port.observeDisconnect('device', reason => events.push(reason), ctx);
    f.manager.isDeviceConnected = async () => true;
    await assert.rejects(f.port.disconnect('device', ctx), { code: 'connection_failed' });
    assert.deepEqual(events, []);
    f.losses[0](new Error('link lost after failed disconnect'), null);
    assert.deepEqual(events, ['link lost after failed disconnect']);
    await f.port.connect('device', ctx);
    let checks = 0;
    f.manager.isDeviceConnected = async () => ++checks < 2;
    await f.port.disconnect('device', ctx);
    assert.equal(checks, 2);
  });

  test(platform + ' reports a peripheral reboot, ignores the old callback after reconnection, and disconnects on request', async () => {
    const f = fixture(platform), ctx = context(), events = [];
    await f.port.connect('device', ctx);
    await f.port.ensureSecure('device', ctx);
    await f.port.observeDisconnect('device', reason => events.push(reason), ctx);
    assert.equal(f.losses.length, 1);
    f.losses[0](new Error('peripheral reboot'), null);
    assert.deepEqual(events, ['peripheral reboot']);
    await assert.rejects(f.port.write(f.address, Uint8Array.of(5), true, ctx));
    await f.port.connect('device', ctx);
    await f.port.ensureSecure('device', ctx);
    const subscription = await f.port.observeDisconnect('device', reason => events.push(reason), ctx);
    f.losses[0](new Error('late callback'), null);
    assert.deepEqual(events, ['peripheral reboot']);
    await subscription.remove();
    await f.port.disconnect('device', ctx);
    assert.ok(f.calls.includes('disconnect'));
  });
}
