import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from '../src/jsHost/__tests__/loadSource.mjs';

const { createBotaReactNativeJsRuntime, createBlePlxPort } = loadSource('../runtime.ts');
const { createBotaClient } = loadSource('../BotaClient.ts');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const cancelled = () => Object.assign(new Error('BLE operation cancelled'), { code: 'cancelled' });
const configureLogs = entries => entries.filter(entry => entry.message === '[BotaClient] Failed to configure SDK');

for (const retired of [true, false]) test(`actual BLE configure cancellation ${retired ? 'after admitted destruction logs debug and joins cleanup' : 'without admitted destruction remains ERROR'}`, async () => {
  const entered = deferred(), state = deferred(), scope = new AbortController();
  let removed = 0;
  const ble = createBlePlxPort({
    async state() { entered.resolve(); return state.promise; },
    onStateChange() { return { remove() { removed++; } }; },
  });
  const runtime = createBotaReactNativeJsRuntime({ apiVersion: 1, platform: 'android', signal: scope.signal,
    randomBytes: count => new Uint8Array(count).fill(1), ble,
    persistence: { namespace: 'test/project/configure', async load() { return null; }, async save() {}, async remove() {} },
  });
  const entries = [], errors = [];
  runtime.client.setLogHandler(entry => entries.push(entry));
  runtime.client.on('error', error => errors.push(error));
  let destruction;
  try {
    const configuring = runtime.client.configure({ logLevel: 'debug' });
    const rejected = assert.rejects(configuring, { code: 'cancelled' });
    await entered.promise;
    scope.abort();
    if (retired) destruction = runtime.client.destroy();
    state.resolve('PoweredOn');
    await rejected; await destruction;
    assert.equal(errors.length, 1); assert.equal(errors[0].code, 'cancelled');
    assert.equal(configureLogs(entries).filter(entry => entry.level === 'error').length, retired ? 0 : 1);
    assert.equal(entries.filter(entry => entry.level === 'debug' && entry.message === '[BotaClient] Retired configure cancelled').length, retired ? 1 : 0);
    if (retired) { assert.equal(removed, 1); assert.equal(runtime.client.state, 'uninitialized'); }
  } finally { state.resolve('PoweredOn'); await runtime.client.destroy(); runtime.client.setLogHandler(null); }
});

function fakeFacade(configure, destroy = async () => {}) {
  const client = createBotaClient({ configure, destroy, devices: {},
    ota: { async cancelFirmwareUpdate() {} },
    recordings: { async loadUploadQueue() { return []; }, async destroyCompatibilityOperations() {} },
    async getState() { return 'ready'; }, async getCapabilities() { return { bluetooth: true }; },
  });
  const entries = [], errors = [];
  client.setLogHandler(entry => entries.push(entry)); client.on('error', error => errors.push(error));
  return { client, entries, errors };
}

test('a non-cancel configure failure racing admitted destroy remains ERROR', async () => {
  const entered = deferred(), gate = deferred();
  const failure = Object.assign(new Error('Radio failed'), { code: 'radio_failed' });
  const f = fakeFacade(async () => { entered.resolve(); await gate.promise; throw failure; });
  try {
    const rejected = assert.rejects(f.client.configure({ logLevel: 'debug' }), error => error === failure);
    await entered.promise; const destruction = f.client.destroy(); gate.resolve();
    await Promise.all([rejected, destruction]);
    assert.equal(configureLogs(f.entries).filter(entry => entry.level === 'error').length, 1);
    assert.deepEqual(f.errors, [failure]);
  } finally { gate.resolve(); await f.client.destroy(); f.client.setLogHandler(null); }
});

test('retired configure cancellation still logs ERROR if cleanup fails', async () => {
  const entered = deferred(), gate = deferred(); const failure = cancelled();
  const cleanupFailure = Object.assign(new Error('Cleanup ownership uncertain'), { code: 'cleanup_incomplete' });
  const f = fakeFacade(async () => { entered.resolve(); await gate.promise; throw failure; }, async () => { throw cleanupFailure; });
  try {
    const rejected = assert.rejects(f.client.configure({ logLevel: 'debug' }), error => error === failure);
    await entered.promise; const destruction = f.client.destroy(); gate.resolve();
    await Promise.all([rejected, destruction]);
    assert.equal(configureLogs(f.entries).filter(entry => entry.level === 'error').length, 1);
    assert.deepEqual(f.errors, [failure]);
  } finally { gate.resolve(); await f.client.destroy(); f.client.setLogHandler(null); }
});

test('a configure queued after destroy is not retired with the preceding attempt', async () => {
  const entered = deferred(), gate = deferred(); let attempts = 0;
  const f = fakeFacade(async () => {
    if (++attempts === 1) { entered.resolve(); await gate.promise; }
    else f.client.on('error', error => f.errors.push(error));
    throw cancelled();
  });
  try {
    const first = assert.rejects(f.client.configure({ logLevel: 'debug' }), { code: 'cancelled' });
    await entered.promise; const destruction = f.client.destroy();
    const next = assert.rejects(f.client.configure({ logLevel: 'debug' }), { code: 'cancelled' });
    gate.resolve(); await Promise.all([first, destruction, next]);
    assert.equal(attempts, 2); assert.equal(f.errors.length, 2);
    assert.equal(entriesByLevel(f.entries, 'debug'), 1);
    assert.equal(configureLogs(f.entries).filter(entry => entry.level === 'error').length, 1);
  } finally { gate.resolve(); await f.client.destroy(); f.client.setLogHandler(null); }
});

test('destroy admitted during failure cleanup cannot relabel a current cancellation', async () => {
  const cleanupEntered = deferred(), cleanupGate = deferred(); let destroys = 0;
  const f = fakeFacade(async () => { throw cancelled(); }, async () => { if (++destroys === 1) { cleanupEntered.resolve(); await cleanupGate.promise; } });
  try {
    const rejected = assert.rejects(f.client.configure({ logLevel: 'debug' }), { code: 'cancelled' });
    await cleanupEntered.promise; const destruction = f.client.destroy(); cleanupGate.resolve();
    await Promise.all([rejected, destruction]);
    assert.equal(configureLogs(f.entries).filter(entry => entry.level === 'error').length, 1);
    assert.equal(entriesByLevel(f.entries, 'debug'), 0);
    assert.equal(f.errors.length, 1);
  } finally { cleanupGate.resolve(); await f.client.destroy(); f.client.setLogHandler(null); }
});

function entriesByLevel(entries, level) {
  return entries.filter(entry => entry.level === level && entry.message === '[BotaClient] Retired configure cancelled').length;
}
