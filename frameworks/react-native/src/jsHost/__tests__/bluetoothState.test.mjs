import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSource } from './loadSource.mjs';

const { createGeneratedJsCore } = loadSource('core.ts');
const { createJsBluetoothState } = loadSource('bluetoothState.ts');
const { createBotaReactNativeJsRuntime } = loadSource('../runtime.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
function fixture({ state = 'PoweredOff', read, remove, observe = true } = {}) {
  const core = createGeneratedJsCore();
  const scope = new AbortController();
  let callback, removals = 0;
  const ports = { apiVersion: 1, platform: 'ios', signal: scope.signal,
    randomBytes: length => new Uint8Array(length).fill(1),
    persistence: { namespace: 'account/project/user', async load() { return null; }, async save() {}, async remove() {} },
    ble: { async connect() {}, async discoverServices() {}, async disconnect() {},
      async scan() { return { async remove() {} }; }, async read() { throw new Error('No device read expected'); },
      async write() { throw new Error('No device write expected'); }, async subscribe() { return { async remove() {} }; },
      readBluetoothState: read ?? (async () => state),
      ...(observe ? { async observeBluetoothState(onState) {
        callback = onState;
        return { async remove() { removals++; await remove?.(); callback = undefined; } };
      } } : {}),
    },
  };
  const failures = [];
  const source = createJsBluetoothState(core, ports, error => failures.push(error));
  return { core, ports, scope, source, failures,
    notify(value) { state = value; callback?.(value); }, get removals() { return removals; } };
}

test('actual generated normalization preserves OS power and permission states', async () => {
  const f = fixture();
  const states = [];
  f.source.watch(state => states.push(state));
  try {
    assert.equal(await f.source.read(), 'poweredOff');
    for (const [raw, expected] of [['Unauthorized', 'unauthorized'], ['Resetting', 'resetting'],
      ['PoweredOn', 'poweredOn'], ['Unsupported', 'unsupported'], ['future_state', 'unknown']]) {
      f.notify(raw); assert.equal(states.at(-1), expected);
    }
  } finally { await f.source.dispose(); f.core.dispose(); }
  assert.equal(f.removals, 1);
});

test('a late state query cannot overwrite a newer observed OS state', async () => {
  const value = deferred(), entered = deferred();
  const f = fixture({ read: async () => { entered.resolve(); return value.promise; } });
  try {
    const reading = f.source.read();
    await entered.promise;
    f.notify('PoweredOn'); value.resolve('PoweredOff');
    assert.equal(await reading, 'poweredOn');
  } finally { await f.source.dispose(); f.core.dispose(); }
});

test('scope cancellation joins captured state read and observer removal before destruction', async () => {
  const value = deferred(), entered = deferred(), removing = deferred(), releaseRemoval = deferred();
  const f = fixture({ read: async () => { entered.resolve(); return value.promise; },
    remove: async () => { removing.resolve(); await releaseRemoval.promise; } });
  const states = [];
  f.source.watch(state => states.push(state));
  const reading = f.source.read();
  const rejected = assert.rejects(reading, { code: 'scope_changed' });
  await entered.promise;
  f.scope.abort();
  let disposed = false;
  const disposal = f.source.dispose().then(() => { disposed = true; });
  await tick(); assert.equal(disposed, false);
  f.notify('PoweredOn'); assert.equal(states.at(-1), 'unknown');
  value.resolve('PoweredOn'); await rejected; await removing.promise;
  assert.equal(disposed, false);
  releaseRemoval.resolve(); await disposal;
  assert.equal(f.removals, 1);
  f.core.dispose();
});

test('destruction joins a submitted observer setup and removes its late subscription before returning', async () => {
  const setup = deferred(), entered = deferred(), removing = deferred(), releaseRemoval = deferred();
  const f = fixture();
  let lateCallback, reads = 0;
  f.ports.ble.observeBluetoothState = async callback => {
    lateCallback = callback; entered.resolve(); await setup.promise;
    return { async remove() { removing.resolve(); await releaseRemoval.promise; } };
  };
  f.ports.ble.readBluetoothState = async () => { reads++; return 'PoweredOn'; };
  const states = [];
  f.source.watch(value => states.push(value));
  const reading = f.source.read();
  const rejection = assert.rejects(reading, { code: 'scope_changed' });
  await entered.promise;
  let disposed = false;
  const disposal = f.source.dispose().then(() => { disposed = true; });
  await tick(); assert.equal(disposed, false);
  lateCallback('PoweredOn'); assert.equal(states.at(-1), 'unknown');
  setup.resolve(); await rejection; await removing.promise;
  assert.equal(disposed, false); assert.equal(reads, 0);
  releaseRemoval.resolve(); await disposal;
  lateCallback('PoweredOn'); assert.equal(states.at(-1), 'unknown');
  f.core.dispose();
});

test('restoring an old namespace cannot revive an invalidated Bluetooth observer', async () => {
  const f = fixture({ state: 'PoweredOn' });
  try {
    assert.equal(await f.source.read(), 'poweredOn');
    f.ports.persistence.namespace = 'another/project/user';
    await assert.rejects(f.source.read(), { code: 'scope_changed' });
    f.ports.persistence.namespace = 'account/project/user';
    await assert.rejects(f.source.read(), { code: 'scope_changed' });
  } finally { await f.source.dispose(); f.core.dispose(); }
});

test('failed Bluetooth observer cleanup reaches the shared owner and cannot report successful disposal', async () => {
  const failure = Object.assign(new Error('OS state observer removal uncertain'), { code: 'cleanup_incomplete' });
  const f = fixture({ remove: async () => { throw failure; } });
  await f.source.read();
  await assert.rejects(f.source.dispose(), error => error === failure);
  assert.deepEqual(f.failures, [failure]);
  f.core.dispose();
});

test('the generated public client waits for OS readiness and observes later permission denial', async () => {
  const f = fixture();
  const runtime = createBotaReactNativeJsRuntime(f.ports);
  const states = [];
  runtime.client.on('bluetoothStateChanged', state => states.push(state));
  try {
    await runtime.client.configure({ logLevel: 'none' });
    assert.equal((await runtime.sdk.getCapabilities()).bluetooth, true);
    assert.equal(runtime.client.bluetoothState, 'poweredOff');
    assert.equal(runtime.client.isBluetoothReady, false);
    const ready = runtime.client.waitForBluetooth(1000);
    f.notify('PoweredOn'); await ready;
    assert.equal(runtime.client.isBluetoothReady, true);
    f.notify('Unauthorized');
    assert.equal(runtime.client.bluetoothState, 'unauthorized');
    assert.equal(runtime.client.isBluetoothReady, false);
    f.notify('Unsupported');
    await assert.rejects(runtime.client.waitForBluetooth(1));
    assert.deepEqual(states, ['poweredOff', 'poweredOn', 'unauthorized', 'unsupported']);
    await runtime.client.destroy();
    f.notify('PoweredOn');
    assert.equal(runtime.client.bluetoothState, 'unknown');
  } finally { await runtime.client.destroy(); await f.source.dispose(); f.core.dispose(); }
});

test('a generated host without state primitives stays unknown rather than inferring powered-on from capability', async () => {
  const f = fixture();
  delete f.ports.ble.readBluetoothState; delete f.ports.ble.observeBluetoothState;
  const runtime = createBotaReactNativeJsRuntime(f.ports);
  try {
    await runtime.client.configure({ logLevel: 'none' });
    assert.equal(runtime.client.bluetoothState, 'unknown');
    assert.equal(runtime.client.isBluetoothReady, false);
    await assert.rejects(runtime.client.waitForBluetooth(0));
  } finally { await runtime.client.destroy(); await f.source.dispose(); f.core.dispose(); }
});

test('a late source-factory failure tears down every constructed resource before disposing its core', async () => {
  const coreModule = loadSource('core.ts');
  const original = coreModule.createGeneratedJsCore;
  const failure = new Error('BYO policy construction failed');
  const disposed = deferred();
  let disposals = 0;
  coreModule.createGeneratedJsCore = () => {
    const core = original();
    return { ...core,
      codec(name, value) { if (name === 'byoLimits') throw failure; return core.codec(name, value); },
      dispose() { disposals++; core.dispose(); disposed.resolve(); },
    };
  };
  const f = fixture();
  const signal = f.scope.signal;
  const active = new Set();
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => {
    if (type === 'abort') active.add(listener); return add(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === 'abort') active.delete(listener); return remove(type, listener, options);
  };
  f.ports.files = Object.fromEntries(['open', 'metadata', 'append', 'truncate', 'read', 'finalize', 'remove', 'flush']
    .map(method => [method, async () => { throw new Error('No file IO expected during construction'); }]));
  try {
    assert.throws(() => createBotaReactNativeJsRuntime(f.ports, {
      backend: { fetch: async () => { throw new Error('No HTTP expected during construction'); } },
      uploadFile: async () => { throw new Error('No upload expected during construction'); },
    }), error => error === failure);
    assert.ok(active.size > 0, 'successfully created owners must remain tracked until cleanup joins');
    await disposed.promise;
    assert.equal(active.size, 0); assert.equal(disposals, 1);
  } finally {
    coreModule.createGeneratedJsCore = original;
    await f.source.dispose(); f.core.dispose();
  }
});
