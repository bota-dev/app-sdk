import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createRecordingSpeechClient } = require('../lib/commonjs/recordingSpeech.js');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const calls = [], events = [], pending = deferred();
  const io = { async start(id, activity) { calls.push(['start', id, activity]); }, async changeTarget(id, language, request) { calls.push(['target', id, language, request]); },
    async qualifyHeadphones() { return true; }, async finish(id) { calls.push(['finish', id]); },
    async events() { return pending.promise; }, async close(id) { calls.push(['close', id]); pending.resolve('[]'); } };
  return { io, calls, events, pending };
}
test('close retires pending native admission and waits for its disposal', { timeout: 5000 }, async () => {
  const f = fixture(), entered = deferred(), admitted = deferred(), disposed = deferred();
  f.io.start = async (id) => { f.calls.push(['start', id]); entered.resolve(); await admitted.promise; };
  f.io.close = async (id) => { f.calls.push(['close', id]); await admitted.promise; disposed.resolve(); };
  const client = createRecordingSpeechClient(f.io);
  const starting = client.start('activity'); await entered.promise;
  const rejected = assert.rejects(starting, { code: 'closed' });
  const closing = client.close(); await Promise.resolve();
  assert.equal(f.calls[1][0], 'close');
  admitted.resolve(); await closing; await rejected; await disposed.promise;
  assert.equal(f.calls.length, 2);
});
test('target controls stay native and late captions keep their target revision', { timeout: 5000 }, async () => {
  const f = fixture(), delivered = deferred();
  const client = createRecordingSpeechClient(f.io);
  const session = await client.start('activity', { onCaption(value) { f.events.push(value); delivered.resolve(); } });
  await session.changeTarget('ja', 'change');
  f.pending.resolve(JSON.stringify([{ type: 'caption', final: true, caption: {
    unitId: 'unit', sourceId: 'source', sourceEpoch: 1, revision: 1, startSample: 0, endSample: 480,
    sourceLanguage: 'en', targetLanguage: 'de', text: 'earlier target',
  } }]));
  await delivered.promise;
  assert.equal(f.events[0].targetLanguage, 'de'); assert.equal(f.events[0].revision, 1);
  assert.equal(await session.qualifyHeadphones(), true);
  await session.finish(); await session.close();
  assert.equal(f.calls.at(-1)[0], 'close');
  await assert.rejects(session.changeTarget('fr', 'late'), { code: 'closed' });
});
test('malformed or overflowing event batches retire native ownership and redact errors', { timeout: 5000 }, async () => {
  const f = fixture(), retired = deferred();
  f.io.close = async id => { f.calls.push(['close', id]); retired.resolve(); };
  const client = createRecordingSpeechClient(f.io);
  await client.start('activity', { onStatus(value) { f.events.push(value); } });
  f.pending.resolve(JSON.stringify(Array(33).fill({ type: 'status', status: 'PRIVATE_TOKEN' })));
  await retired.promise; await client.close();
  assert.deepEqual(f.events, ['bridge_unavailable']);
  assert.equal(f.calls.filter(c => c[0] === 'close').length, 1);
});
test('failed cleanup is stable and prevents replacing the native owner', { timeout: 5000 }, async () => {
  const f = fixture(); f.io.close = async () => { f.pending.resolve('[]'); throw new Error('PRIVATE_TOKEN'); };
  const client = createRecordingSpeechClient(f.io);
  const session = await client.start('activity');
  await assert.rejects(session.close(), { code: 'cleanup_failed', message: 'cleanup_failed' });
  await assert.rejects(client.start('replacement'), { code: 'cleanup_failed' });
});
