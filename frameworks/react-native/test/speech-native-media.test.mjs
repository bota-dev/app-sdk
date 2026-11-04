import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createNativeSpeechMedia } = require('../lib/commonjs/speechNativeMedia.js');
const grant = { session_id: 'session' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const actions = [], events = [];
  const callbacks = { text: (...value) => events.push(value), trackRemoved: sid => events.push(sid),
    disconnected: () => events.push('disconnected'), failed: () => events.push('failed'), playbackBlocked: () => events.push('blocked') };
  const io = { async createMedia() { return 'native_owner'; },
    async mediaCommand(handle, action, body) { actions.push([handle, action, body]); return action === 'input' && body === 'true' ? '"TR_original"' : 'null'; },
    mediaFence(handle, action) { actions.push([handle, action]); return true; },
    async mediaEvents() { return '[]'; }, async closeMedia(handle) { actions.push([handle, 'close']); } };
  return { callbacks, io, actions, events, signal: new AbortController().signal };
}
test('late native media acquisition is joined and retired exactly once', { timeout: 5000 }, async () => {
  const f = fixture(), entered = deferred(), created = deferred();
  f.io.createMedia = async () => { entered.resolve(); return created.promise; };
  const port = createNativeSpeechMedia(f.callbacks, f.io);
  const connected = port.connect(grant, f.signal); await entered.promise;
  let settled = false; const closing = port.close().then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  created.resolve('late_owner'); await assert.rejects(connected, { code: 'closed' }); await closing;
  assert.deepEqual(f.actions, [['late_owner', 'close']]); await port.close();
});
test('native IO fencing precedes close and never invokes independent capture controls', { timeout: 5000 }, async () => {
  const f = fixture(), held = deferred();
  f.io.mediaEvents = () => held.promise;
  const port = createNativeSpeechMedia(f.callbacks, f.io);
  await port.connect(grant, f.signal); await port.setMicrophone(true, f.signal);
  assert.equal(port.microphonePublication(), 'TR_original');
  port.holdMicrophone();
  const closing = port.close();
  held.resolve(JSON.stringify([{ type: 'text', sender: 'worker', json: 'late' }]));
  await closing; assert.deepEqual(f.events, []);
  assert.deepEqual(f.actions.slice(-4), [['native_owner', 'hold'], ['native_owner', 'silence'], ['native_owner', 'mute'], ['native_owner', 'close']]);
});
test('bounded native event overflow fails closed while original ownership remains external', { timeout: 5000 }, async () => {
  const f = fixture(), drained = deferred();
  f.io.mediaEvents = () => drained.promise;
  const port = createNativeSpeechMedia(f.callbacks, f.io);
  await port.connect(grant, f.signal);
  drained.resolve(JSON.stringify(Array(33).fill({ type: 'blocked' })));
  for (let i = 0; i < 10 && !f.events.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.events, ['failed']); await port.close();
});
test('a failing playback fence still mutes and joins native cleanup', { timeout: 5000 }, async () => {
  const f = fixture(), drained = deferred();
  f.io.mediaEvents = () => drained.promise;
  f.io.mediaFence = (handle, action) => { f.actions.push([handle, action]); return action !== 'silence'; };
  const port = createNativeSpeechMedia(f.callbacks, f.io);
  await port.connect(grant, f.signal);
  const closing = port.close();
  drained.resolve('[]');
  await assert.rejects(closing, { code: 'cleanup_failed' });
  assert.deepEqual(f.actions.slice(-3), [['native_owner', 'silence'], ['native_owner', 'mute'], ['native_owner', 'close']]);
  assert.equal(port.close(), closing);
});
test('event failure closes native media even when the failure callback throws', { timeout: 5000 }, async () => {
  const f = fixture(), drained = deferred(), retired = deferred();
  f.io.mediaEvents = () => drained.promise;
  f.io.closeMedia = async handle => { f.actions.push([handle, 'close']); retired.resolve(); };
  f.callbacks.failed = () => { throw new Error('App callback failed'); };
  const port = createNativeSpeechMedia(f.callbacks, f.io);
  await port.connect(grant, f.signal);
  drained.resolve('invalid JSON');
  await retired.promise; await port.close();
  assert.equal(f.actions.at(-1)[1], 'close');
});
