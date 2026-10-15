import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './loadSource.mjs';

const { BotaJsHostExecutor } = loadSource('executor.ts');
const { JsFileEffects } = loadSource('fileEffects.ts');
const { JsRecordingUploads } = loadSource('recordingUploads.ts');

const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
function fixture(first, dispatch, cancel) {
  const calls = [];
  let next = 9007199254740993n;
  let identity;
  const envelope = effect => ({ request_id: (next++).toString(),
    operation: identity.operation, cancellation_id: identity.cancellation_id, effect });
  const factory = { codec(name, input) {
    if (name === 'subscriptionStartupPolicy') return { replayBeforeSubscribed: false };
    if (name === 'normalizeWorkflowError') return { ...input.error, protocolStatus: input.error.protocol_status };
    throw new Error('not used');
  }, createEngine() {
    return { dispose() { calls.push('dispose'); }, request(input) {
      calls.push(input);
      identity = input;
      if (input.action === 'start') return { ok: true, result: {
        effects: first.map(envelope), status: { Running: { operation: input.operation } },
      } };
      if (input.action === 'cancel') return { ok: true, result: cancel?.(input) ?? {
        effects: [envelope({ Notify: { Cancelled: { operation: input.operation } } })],
        status: { Cancelled: { operation: input.operation } },
      } };
      const result = dispatch?.(input);
      return { ok: true, result: result ?? { effects: [envelope({ Notify: {
        Completed: { operation: input.operation },
      } })], status: { Completed: { operation: input.operation } } } };
    } };
  } };
  const ports = { platform: 'test', randomBytes: () => Uint8Array.from({ length: 16 }, (_, i) => i),
    persistence: { namespace: 'account/project/user', async load() { return null; },
      async save() {}, async remove() {} },
    ble: { async scan() { return { async remove() {} }; }, async connect() {},
      async discoverServices() {}, async disconnect() {}, async read() { return Uint8Array.of(7); },
      async write() {}, async subscribe() { return { async remove() {} }; } },
  };
  return { calls, factory, ports, envelope };
}
const options = { operation: 'Reconnect', operationId: 'exact-operation' };
const read = { Ble: { Read: { service_uuid: '180A', characteristic_uuid: '2A25' } } };

test('an exact OS disconnect is dispatched through the live Subscribe request and ignores old link callbacks', async () => {
  const subscribed = deferred();
  const start = { Ble: { Connect: { peripheral_id: 'owned-link' } } };
  let notify;
  const f = fixture([start], input => {
    if (input.event.kind.Ble.Connected) return { effects: [f.envelope({ Ble: { Subscribe: {
      service_uuid: 'storage', characteristic_uuid: 'status' } } })], status: { Running: { operation: options.operation } } };
    if (input.event.kind.Ble.Subscribed) { subscribed.resolve(); return { effects: [], status: { Running: { operation: options.operation } } }; }
    assert.equal(input.event.kind.Ble.Disconnected.peripheral_id, 'owned-link');
    return { effects: [f.envelope({ Ble: { Unsubscribe: { service_uuid: 'storage', characteristic_uuid: 'status' } } }),
      f.envelope({ Notify: { Completed: { operation: options.operation } } })], status: { Completed: { operation: options.operation } } };
  });
  f.ports.ble.subscribe = async (_address, callback) => { notify = callback; return { async remove() {} }; };
  const executor = new BotaJsHostExecutor(f.factory, f.ports);
  const running = executor.run({}, options);
  await subscribed.promise;
  assert.equal(await executor.peripheralDisconnected('another-link'), false);
  assert.equal(await executor.peripheralDisconnected('owned-link'), true);
  await running;
  const callbacks = f.calls.filter(call => call.action === 'dispatch');
  assert.equal(callbacks.find(call => call.event.kind.Ble.Disconnected).event.request_id,
    callbacks.find(call => call.event.kind.Ble.Subscribed).event.request_id);
  assert.equal(f.calls.some(call => call.action === 'cancel'), false);
  const count = f.calls.length;
  notify(Uint8Array.of(1));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, count);
  await executor.destroy();
});

test('status monitor errors reach shared BleFailed policy instead of unconditionally cancelling', async () => {
  const subscribed = deferred();
  let onError;
  const f = fixture([{ Ble: { Subscribe: { service_uuid: 'storage', characteristic_uuid: 'status' } } }], input => {
    if (input.event.kind.Ble.Subscribed) { subscribed.resolve(); return { effects: [], status: { Running: { operation: options.operation } } }; }
    assert.deepEqual(input.event.kind, { Ble: { Failed: { platform_code: '-7' } } });
    return { effects: [f.envelope({ Notify: { Completed: { operation: options.operation } } })],
      status: { Completed: { operation: options.operation } } };
  });
  f.ports.ble.subscribe = async (_address, _callback, _context, failed) => { onError = failed; return { async remove() {} }; };
  const executor = new BotaJsHostExecutor(f.factory, f.ports);
  const running = executor.run({}, options);
  await subscribed.promise;
  onError({ platformCode: -7 });
  await running;
  assert.equal(f.calls.some(call => call.action === 'cancel'), false);
  await executor.destroy();
});

test('workflow-owned registration cleanup remains joined before replacement work is admitted', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture([read]);
  const executor = new BotaJsHostExecutor(f.factory, f.ports);
  const running = executor.run({}, options, async context => {
    assert.equal(context.signal.aborted, false);
    entered.resolve(); await release.promise;
  });
  await entered.promise;
  await assert.rejects(executor.direct('replacement', async () => {}), { code: 'operation_in_progress' });
  release.resolve(); await running;
  await executor.direct('replacement', async () => {});
  await executor.destroy();
});

test('logout joins ignored primitive cancellation and permanently fences the captured scope', async () => {
  const f = fixture([read]);
  const scope = new AbortController();
  f.ports.signal = scope.signal;
  const submitted = deferred();
  const entered = deferred();
  f.ports.ble.read = async () => { entered.resolve(); return submitted.promise; };
  const executor = new BotaJsHostExecutor(f.factory, f.ports);
  const running = executor.run({}, options);
  void running.catch(() => {});
  await entered.promise;
  scope.abort();
  await assert.rejects(executor.direct('ReplacementScope', async () => 1), { code: 'scope_changed' });
  assert.equal(executor.activeOperationId, options.operationId);
  submitted.resolve(Uint8Array.of(7));
  await assert.rejects(running, { code: 'scope_changed' });
  assert.equal(f.calls.filter(call => call.action === 'dispatch').length, 0);
  await executor.destroy();
});

test('a mutable persistence namespace cannot redirect a captured operation into another tenant', async () => {
  const f = fixture([read]);
  const executor = new BotaJsHostExecutor(f.factory, f.ports);
  f.ports.persistence.namespace = 'replacement/project/user';
  await assert.rejects(executor.run({}, options), { code: 'scope_changed' });
  assert.equal(f.calls.length, 0);
  await executor.destroy();
});

test('a failed passive teardown prevents unrelated direct or workflow replacement', async () => {
  const f = fixture([read]);
  const executor = new BotaJsHostExecutor(f.factory, f.ports);
  const failure = new Error('captured subscription did not settle');
  executor.markCleanupFailed(failure);
  await assert.rejects(executor.direct('Control', async () => 1), { code: 'cleanup_incomplete' });
  await assert.rejects(executor.run({}, options), { code: 'cleanup_incomplete' });
  assert.equal(f.calls.length, 0);
  await executor.destroy();
});

test('exact core request/cancellation/generation identity retains u64 precision through a primitive read', async () => {
  const host = fixture([read]);
  const executor = new BotaJsHostExecutor(host.factory, host.ports);
  await executor.run({ Reconnect: {} }, options);
  const start = host.calls[0];
  const callback = host.calls.find(call => call.action === 'dispatch');
  assert.equal(callback.event.request_id, '9007199254740993');
  assert.equal(callback.generation, start.generation);
  assert.equal(callback.operation, 'Reconnect');
  assert.deepEqual(callback.cancellation_id, start.cancellation_id);
  assert.deepEqual(callback.event.kind, { Ble: { ReadCompleted: { value: [7] } } });
  await executor.destroy();
});

test('cancellation joins an initiated primitive before admitting the next owner and ignores its late result', async () => {
  const entered = deferred();
  const release = deferred();
  const host = fixture([read]);
  host.ports.ble.read = async () => { entered.resolve(); await release.promise; return Uint8Array.of(9); };
  const executor = new BotaJsHostExecutor(host.factory, host.ports);
  const running = executor.run({ Reconnect: {} }, options);
  const rejected = assert.rejects(running, error => error.code === 'operation_cancelled');
  await entered.promise;
  let cancelled = false;
  const cancellation = executor.cancel(options.operationId).then(() => { cancelled = true; });
  await assert.rejects(executor.direct('Connect', async () => {}), error => error.code === 'operation_in_progress');
  assert.equal(cancelled, false);
  release.resolve();
  await Promise.all([rejected, cancellation]);
  assert.equal(host.calls.filter(call => call.action === 'dispatch').length, 0);
  await executor.direct('Connect', async () => {});
  await executor.destroy();
});

test('primitive GATT effects share an ordered queue with direct controls', async () => {
  const host = fixture([]);
  const executor = new BotaJsHostExecutor(host.factory, host.ports);
  const firstEntered = deferred();
  const release = deferred();
  const order = [];
  const running = executor.direct('Read', async context => {
    const first = executor.gatt(context, async () => { order.push('first'); firstEntered.resolve(); await release.promise; });
    const second = executor.gatt(context, async () => { order.push('second'); });
    await Promise.all([first, second]);
  });
  await firstEntered.promise;
  assert.deepEqual(order, ['first']);
  release.resolve();
  await running;
  assert.deepEqual(order, ['first', 'second']);
  await executor.destroy();
});

test('subscription ownership survives setup and cleanup; late notifications cannot reach a new workflow', async () => {
  let listener;
  let removed = 0;
  const subscribed = deferred();
  const host = fixture([{ Ble: { Subscribe: { service_uuid: 'B07A0001', characteristic_uuid: 'B07A0002' } } }], input => {
    if (input.event.kind.Ble.Subscribed) {
      subscribed.resolve();
      return { effects: [], status: { Running: { operation: 'Reconnect' } } };
    }
  });
  host.ports.ble.subscribe = async (_address, onValue) => {
    listener = onValue;
    onValue(Uint8Array.of(1));
    return { async remove() { removed++; } };
  };
  const executor = new BotaJsHostExecutor(host.factory, host.ports);
  const running = executor.run({ Reconnect: {} }, options);
  await subscribed.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.calls.some(call => call.event?.kind.Ble?.Notification), false);
  listener(Uint8Array.of(2));
  await running;
  assert.equal(removed, 1);
  const count = host.calls.length;
  listener(Uint8Array.of(3));
  await Promise.resolve();
  assert.equal(host.calls.length, count);
  await executor.destroy();
});

test('uncertain subscription cleanup retains the owner and rejects replacement work', async () => {
  const host = fixture([{ Ble: { Subscribe: { service_uuid: '1', characteristic_uuid: '2' } } }]);
  host.ports.ble.subscribe = async () => ({ async remove() { throw new Error('unsubscribe uncertain'); } });
  const executor = new BotaJsHostExecutor(host.factory, host.ports);
  await assert.rejects(executor.run({ Reconnect: {} }, options), /unsubscribe uncertain/);
  await assert.rejects(executor.direct('Connect', async () => {}), error => error.code === 'operation_in_progress');
  await assert.rejects(executor.destroy(), /unsubscribe uncertain/);
  assert.ok(host.calls.includes('dispose'));
});

test('foreign effect identity is rejected before any host I/O', async () => {
  const host = fixture([read]);
  const create = host.factory.createEngine;
  host.factory.createEngine = () => {
    const engine = create();
    const request = engine.request;
    engine.request = input => {
      const output = request(input);
      if (input.action === 'start') output.result.effects[0].cancellation_id = Array(16).fill(255);
      return output;
    };
    return engine;
  };
  let reads = 0;
  host.ports.ble.read = async () => { reads++; return Uint8Array.of(1); };
  const executor = new BotaJsHostExecutor(host.factory, host.ports);
  await assert.rejects(executor.run({ Reconnect: {} }, options), error => error.code === 'invalid_core_identity');
  assert.equal(reads, 0);
  await executor.destroy();
});

test('missing protected primitives fail closed instead of converting an opaque handle to JS bytes', async () => {
  const host = fixture([read]);
  host.ports.ble.read = async () => ({ id: 'protected', kind: 'protected_packet', scope: 'account/project/user' });
  const executor = new BotaJsHostExecutor(host.factory, host.ports);
  await assert.rejects(executor.run({ Reconnect: {} }, options), error => error.code === 'missing_primitive:opaque_gatt_read');
  assert.equal(host.calls.filter(call => call.action === 'dispatch').length, 0);
  await executor.destroy();
});

test('direct cancellation joins a pending host call instead of releasing ownership early', async () => {
  const host = fixture([]);
  const executor = new BotaJsHostExecutor(host.factory, host.ports);
  const entered = deferred();
  const release = deferred();
  const direct = executor.direct('Direct', async () => { entered.resolve(); await release.promise; });
  const rejection = assert.rejects(direct, error => error.code === 'stale_host_owner');
  await entered.promise;
  const id = executor.activeOperationId;
  let settled = false;
  const cancelled = executor.cancel(id).then(() => { settled = true; });
  await assert.rejects(executor.direct('Connect', async () => {}), error => error.code === 'operation_in_progress');
  assert.equal(settled, false);
  release.resolve();
  await Promise.all([cancelled, rejection]);
  assert.equal(host.calls.filter(call => call.action === 'cancel').length, 0);
  await executor.destroy();
});

test('direct completion joins borrowed control cleanup before admitting replacement work', async () => {
  const host = fixture([]);
  const executor = new BotaJsHostExecutor(host.factory, host.ports);
  const entered = deferred(), releaseBody = deferred();
  const borrowedEntered = deferred(), releaseCleanup = deferred();
  let completed = false;
  const direct = executor.direct('ByoUpload', async () => {
    entered.resolve(); await releaseBody.promise; return 7;
  }, { operationId: 'live-byo' }).then(value => { completed = true; return value; });
  await entered.promise;
  const borrowed = executor.borrowDirect('live-byo', async () => {
    borrowedEntered.resolve(); await releaseCleanup.promise; return 9;
  });
  await borrowedEntered.promise;
  releaseBody.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  assert.equal(executor.activeOperationId, 'live-byo');
  await assert.rejects(executor.direct('Connect', async () => {}), { code: 'operation_in_progress' });
  await assert.rejects(executor.borrowDirect('live-byo', async () => {}), { code: 'operation_in_progress' });
  releaseCleanup.resolve();
  assert.deepEqual(await Promise.all([direct, borrowed]), [7, 9]);
  await executor.direct('Connect', async () => {});
  await executor.destroy();
});

test('external cancellation remains live while direct completion joins borrowed cleanup', async () => {
  const host = fixture([]);
  const executor = new BotaJsHostExecutor(host.factory, host.ports);
  const external = new AbortController();
  const entered = deferred(), releaseBody = deferred();
  const borrowedEntered = deferred(), aborted = deferred(), releaseCleanup = deferred();
  let settled = false;
  const direct = executor.direct('ByoUpload', async () => {
    entered.resolve(); await releaseBody.promise; return 7;
  }, { operationId: 'live-byo', signal: external.signal });
  const rejected = assert.rejects(direct, { code: 'operation_cancelled' }).then(() => { settled = true; });
  await entered.promise;
  const borrowed = executor.borrowDirect('live-byo', async context => {
    borrowedEntered.resolve();
    await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
    aborted.resolve();
    await releaseCleanup.promise;
  });
  const borrowedRejected = assert.rejects(borrowed, { code: 'stale_host_owner' });
  await borrowedEntered.promise;
  releaseBody.resolve();
  await new Promise(resolve => setImmediate(resolve));
  external.abort();
  await aborted.promise;
  assert.equal(settled, false);
  await assert.rejects(executor.direct('Connect', async () => {}), { code: 'operation_in_progress' });
  releaseCleanup.resolve();
  await Promise.all([rejected, borrowedRejected]);
  await executor.direct('Connect', async () => {});
  await executor.destroy();
});

test('ordinary admission can await exact settlement but cleanup failure still prevents the next write', async () => {
  for (const cleanupFails of [false, true]) {
    const host = fixture([]);
    const executor = new BotaJsHostExecutor(host.factory, host.ports);
    const entered = deferred(), releaseBody = deferred(), enteredTail = deferred(), releaseTail = deferred();
    const failure = Object.assign(new Error('Uncertain cleanup'), { code: 'cleanup_incomplete' });
    let writes = 0;
    const direct = executor.direct('readStatus', async () => {
      entered.resolve(); await releaseBody.promise;
    }, { operationId: 'ordinary-control' });
    void direct.catch(() => {});
    await entered.promise;
    const tail = executor.borrowDirect('ordinary-control', async () => {
      enteredTail.resolve(); await releaseTail.promise;
      if (cleanupFails) executor.markCleanupFailed(failure);
    });
    void tail.catch(() => {});
    await enteredTail.promise;
    releaseBody.resolve();
    await new Promise(resolve => setImmediate(resolve));
    // Admission does no IO and is allowed through this controlled finish window.
    assert.doesNotThrow(() => executor.checkControlAdmission('writeConnectionSettings', 'ordinary-control'));
    assert.throws(() => executor.checkControlAdmission('writeConnectionSettings', 'other-owner'), { code: 'operation_in_progress' });
    await assert.rejects(executor.direct('writeConnectionSettings', async () => { writes++; }), { code: 'operation_in_progress' });
    const next = direct.then(() => undefined, () => undefined).then(() => executor.direct('writeConnectionSettings', async () => { writes++; }));
    const result = cleanupFails ? assert.rejects(next) : next;
    releaseTail.resolve();
    await Promise.allSettled([direct, tail]);
    await result;
    assert.equal(writes, cleanupFails ? 0 : 1);
    await executor.destroy().catch(() => {});
  }
});

test('a core deadline can fire while its primitive read is still blocked', async () => {
  const entered = deferred();
  const timerFired = deferred();
  const host = fixture([read, { Timer: { Schedule: { timer_id: '1', delay_ms: '0' } } }], input => {
    if (input.event.kind.TimerFired) timerFired.resolve();
  });
  host.ports.ble.read = async (_address, context) => {
    entered.resolve();
    await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('read interrupted');
  };
  const executor = new BotaJsHostExecutor(host.factory, host.ports);
  const running = executor.run({ Reconnect: {} }, options);
  await entered.promise;
  // The Rust terminal notification aborts the old request but waits for its settlement.
  await timerFired.promise;
  await running;
  assert.ok(host.calls.some(call => call.event?.kind.TimerFired));
  await executor.destroy();
});

test('terminal cleanup gets a live signal and never dispatches a callback into a completed core', async () => {
  let disconnects = 0;
  const host = fixture([read], () => ({ effects: [host.envelope({ Ble: { Disconnect: { peripheral_id: 'exact-device' } } })],
    status: { Completed: { operation: 'Reconnect' } } }));
  host.ports.ble.disconnect = async (id, context) => {
    assert.equal(id, 'exact-device');
    assert.equal(context.signal.aborted, false);
    disconnects++;
  };
  const executor = new BotaJsHostExecutor(host.factory, host.ports);
  await executor.run({ Reconnect: {} }, options);
  assert.equal(disconnects, 1);
  assert.equal(host.calls.filter(call => call.action === 'dispatch').length, 1);
  await executor.destroy();
});

test('terminal core result drops ordinary effects that have not reached the port', async () => {
  const host = fixture([{ HostMaterial: 'Ready' }, read]);
  let reads = 0;
  host.ports.ble.read = async () => { reads++; return Uint8Array.of(7); };
  const executor = new BotaJsHostExecutor(host.factory, host.ports);
  executor.registerHandler('HostMaterial', async (_effect, context) => {
    await context.emit('HostMaterialReady');
    return null;
  });
  await executor.run({}, options);
  assert.equal(reads, 0);
  assert.equal(host.calls.filter(call => call.action === 'dispatch').length, 1);
  assert.equal(executor.activeOperationId, undefined);
  await executor.destroy();
});

test('failed terminal OS cleanup retains the owner and surfaces the failure', async () => {
  const host = fixture([read], () => ({ effects: [host.envelope({ Ble: { Disconnect: { peripheral_id: 'device' } } })],
    status: { Completed: { operation: 'Reconnect' } } }));
  host.ports.ble.disconnect = async () => { throw new Error('disconnect uncertain'); };
  const executor = new BotaJsHostExecutor(host.factory, host.ports);
  await assert.rejects(executor.run({ Reconnect: {} }, options), /disconnect uncertain/);
  await assert.rejects(executor.direct('Connect', async () => {}), error => error.code === 'operation_in_progress');
  await assert.rejects(executor.destroy(), /disconnect uncertain/);
});

for (const [cancelled, discardFails] of [[false, false], [false, true], [true, false]]) test(`${cancelled ? 'cancelled' : 'failed'} discard joins its submitted append and ${discardFails ? 'retains genuine cleanup failure' : 'releases the owner'}`, { timeout: 5000 }, async () => {
  const entered = deferred(), release = deferred(), terminal = deferred();
  const removed = deferred(), releaseRemove = deferred();
  const order = [];
  const operation = { operation: 'TransferRecording', operationId: 'failed-transfer' };
  const terminalResult = input => {
    terminal.resolve();
    return { effects: [host.envelope({ RecordingSink: { Discard: { sink_id: 'sink' } } }),
      host.envelope({ Persistence: 'DeleteCheckpoint' }), host.envelope({ Notify: input.action === 'cancel'
        ? { Cancelled: { operation: operation.operation } } : { Failed: {
        error: { code: 'integrity_failed', operation: operation.operation, retryable: true },
      } } })], status: { [input.action === 'cancel' ? 'Cancelled' : 'Failed']: { operation: operation.operation } } };
  };
  const append = { RecordingSink: { Append: { sink_id: 'sink', payload: [1, 2, 3] } } };
  const host = fixture(cancelled ? [append] : [append, read], terminalResult, terminalResult);
  const handle = { id: 'captured-sink', kind: 'file', scope: host.ports.persistence.namespace };
  const files = {
    async open() { return handle; },
    async metadata() { return { durableUnits: '0' }; },
    async append(_handle, _offset, _payload, context) {
      order.push('append'); entered.resolve();
      await release.promise;
      assert.equal(context.signal.aborted, true);
      order.push('append-settled');
      return { durableUnits: '3' };
    },
    async remove(_handle, context) {
      assert.equal(context.signal.aborted, false);
      order.push('remove'); removed.resolve();
      await releaseRemove.promise;
      if (discardFails) throw new Error('discard uncertain');
    },
  };
  const uploads = new JsRecordingUploads({ core: host.factory, files, persistence: host.ports.persistence,
    fetch: async () => { throw new Error('not used'); }, uploadFile: async () => {},
    lookup: async () => { throw new Error('not used'); }, checkOwner() {}, onProgress() {} });
  const effects = new JsFileEffects(files, host.ports.persistence.namespace, value => uploads.acquireWritable(value));
  host.ports.ble.read = async () => { await entered.promise; return Uint8Array.of(7); };
  const executor = new BotaJsHostExecutor(host.factory, host.ports);
  executor.registerHandler('RecordingSink', effects.recordingSink);
  let settled = false;
  const running = executor.run({}, operation);
  const rejected = assert.rejects(running, { code: cancelled ? 'operation_cancelled' : 'integrity_failed' })
    .then(() => { settled = true; });
  let cancellation;
  try {
    if (cancelled) { await entered.promise; cancellation = executor.cancel(operation.operationId); }
    await terminal.promise;
    await assert.rejects(executor.direct('Replacement', async () => {}), { code: 'operation_in_progress' });
    assert.equal(settled, false);
    assert.throws(() => uploads.acquireWritable(handle), { code: 'operation_in_progress' });
    release.resolve();
    await Promise.race([removed.promise, running.then(
      () => assert.fail('transfer settled before discard entered'),
      () => assert.fail('transfer failed before its same-sink discard could enter'),
    )]);
    assert.deepEqual(order, ['append', 'append-settled', 'remove']);
    assert.equal(settled, false);
    await assert.rejects(executor.direct('Replacement', async () => {}), { code: 'operation_in_progress' });
    releaseRemove.resolve();
    await rejected;
    await cancellation;
    assert.equal(host.calls.filter(call => call.action === 'dispatch').length, cancelled ? 0 : 1);
    if (discardFails) {
      await assert.rejects(executor.direct('Replacement', async () => {}), { code: 'operation_in_progress' });
      await assert.rejects(executor.destroy(), /discard uncertain/);
    } else {
      assert.equal(executor.activeOperationId, undefined);
      await executor.cancel(operation.operationId);
      await executor.direct('Replacement', async () => {});
      await executor.destroy();
    }
  } finally {
    release.resolve(); releaseRemove.resolve();
  }
});

test('reset receipt is gated on durable SDK and application result persistence', async () => {
  const applicationEntered = deferred();
  const release = deferred();
  const order = [];
  const host = fixture([{ Persistence: { SaveFactoryResetResult: {
    result: { command_id: 'exact-reset', result: { result_code: 0, deleted_recording_count: 2 } },
  } } }]);
  host.ports.persistence.save = async key => { order.push(key); };
  const executor = new BotaJsHostExecutor(host.factory, host.ports);
  const running = executor.run({ FactoryReset: {} }, { ...options, operation: 'FactoryReset',
    async beforeFactoryResetReceipt(result, context) {
      assert.equal(result.command_id, 'exact-reset');
      assert.equal(context.operation, 'FactoryReset');
      order.push('application'); applicationEntered.resolve(); await release.promise;
    },
  });
  await applicationEntered.promise;
  assert.deepEqual(order, ['reset/exact-reset', 'application']);
  assert.equal(host.calls.filter(call => call.action === 'dispatch').length, 0);
  release.resolve();
  await running;
  assert.equal(host.calls.find(call => call.action === 'dispatch').event.kind, 'FactoryResetResultSaved');
  await executor.destroy();
});

test('confirmed direct disconnect clears only its exact tracked device and destroy does not repeat it', async () => {
  const host = fixture([{ Ble: { Connect: { peripheral_id: 'exact-device' } } }]);
  const disconnected = [];
  host.ports.ble.disconnect = async id => { disconnected.push(id); };
  const executor = new BotaJsHostExecutor(host.factory, host.ports);
  await executor.run({ ConnectSelected: {} }, { ...options, operation: 'Connect' });
  assert.equal(executor.connectedPeripheralId, 'exact-device');
  executor.didDisconnect('old-device');
  assert.equal(executor.connectedPeripheralId, 'exact-device');
  await executor.direct('Disconnect', async context => {
    await executor.gatt(context, () => host.ports.ble.disconnect('exact-device', context));
    executor.didDisconnect('exact-device');
  });
  assert.equal(executor.connectedPeripheralId, undefined);
  await executor.destroy();
  assert.deepEqual(disconnected, ['exact-device']);
});
