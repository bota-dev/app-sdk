const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('../../../../protocol/speech-session/client-v1.json');
const { Companion } = require('../target/controller.js');
const { labHost } = require('../target/host.js');
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function initial() {
  return { role: 'a', peer: { role: 'b', participantId: fixture.configuration.subscription.sourceParticipantIds[0] },
    allowedLanguages: ['zh', 'ja', 'en'], configuration: { ...fixture.configuration, subscription: {
      ...fixture.configuration.subscription, sourceParticipantIds: [fixture.configuration.subscription.sourceParticipantIds[0]] } },
    grant: { ...fixture.grant, expires_at: new Date(Date.now() + 60000).toISOString() } };
}
function setup(overrides = {}) {
  let captured = false, closed = 0, callbacks;
  const native = { request: async (_id, _origin, _role, _code, action, body) => ({ status: 200, body: JSON.stringify(
    action === 'join' ? initial() : action === 'subscription' ? { targetLanguage: JSON.parse(body).targetLanguage, mode: JSON.parse(body).mode, revision: 2,
      sourceParticipantIds: initial().configuration.subscription.sourceParticipantIds } : {}) }),
    cancel: async () => {}, microphonePermission: async () => true, ...overrides };
  const app = new Companion({ native, mediaFactory(value) { callbacks = value; return {
    async connect() { if (overrides.connectFails) throw Error('private connect detail'); }, silencePlayback() {}, muteMicrophone() { captured = false; },
    async clearPlayback() {}, async setPlayback() {}, async setMicrophone(enabled) { captured = enabled; },
    async close() { closed++; if (overrides.cleanupFails) throw Error('private transport detail'); },
  }; } });
  return { app, native, captured: () => captured, closed: () => closed, callbacks: () => callbacks,
    join: () => app.join('http://127.0.0.1:4173', 'a', 'x'.repeat(32)) };
}
test('late bootstrap after leave cannot create media or re-enter before HTTP settles', async () => {
  const wait = deferred(); const f = setup({ request: async () => wait.promise });
  const joining = f.join(); const leaving = f.app.leave();
  assert.equal(f.app.phase, 'closing'); await f.join();
  wait.resolve({ status: 200, body: JSON.stringify(initial()) }); await joining; await leaving;
  assert.equal(f.closed(), 0); assert.equal(f.app.phase, 'idle');
});
test('late permission cannot capture and stopping listening preserves microphone', async () => {
  const permission = deferred(); const f = setup({ microphonePermission: () => permission.promise });
  await f.join(); const turningOn = f.app.microphone(); const leaving = f.app.leave();
  permission.resolve(true); await turningOn; await leaving;
  assert.equal(f.captured(), false); assert.equal(f.closed(), 1);
  const g = setup(); await g.join(); await g.app.microphone(); await g.app.listen(); await g.app.listen();
  assert.equal(g.captured(), true); await g.app.leave(); assert.equal(g.captured(), false);
});
test('failed media cleanup clears content and permanently refuses re-entry', async () => {
  const f = setup({ cleanupFails: true }); await f.join(); await f.app.leave(); await f.join();
  assert.equal(f.app.phase, 'failed'); assert.equal(f.closed(), 1); assert.deepEqual(f.app.pairs, []);
  assert.ok(!f.app.error.includes('private'));
});
test('failed startup cleanup retires authorization metadata as well as media', async () => {
  const f = setup({ connectFails: true, cleanupFails: true }); await f.join(); await f.app.leave();
  assert.equal(f.app.phase, 'failed'); assert.equal(f.app.joined, undefined); assert.equal(f.app.pairs.length, 0);
  assert.ok(!f.app.error.includes('private'));
});
test('host rejects unsupported retention and mismatched peer before media creation', async () => {
  for (const mutate of [x => { x.configuration = { ...x.configuration, context: { ...x.configuration.context, retention: 'original_audio_and_text' } }; },
    x => { x.peer.participantId = x.configuration.context.participantId; }]) {
    const value = initial(); mutate(value);
    const f = setup({ request: async () => ({ status: 200, body: JSON.stringify(value) }) });
    await f.join(); assert.equal(f.app.phase, 'idle'); assert.equal(f.closed(), 0);
  }
});
test('native cancellation is joined and a canceled HTTP response cannot return authorization', async () => {
  const response = deferred(), canceled = deferred(); let calls = 0;
  const host = labHost({ request: () => response.promise, cancel: async () => { calls++; await canceled.promise; },
    microphonePermission: async () => true }, 'http://127.0.0.1:4173', 'a', 'x'.repeat(32));
  const abort = new AbortController(); const joining = host.join(abort.signal); abort.abort();
  let settled = false; const closing = host.close().then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false); assert.equal(calls, 1);
  response.resolve({ status: 200, body: JSON.stringify(initial()) }); canceled.resolve();
  await assert.rejects(joining); await closing;
});
test('real generated policy delivers bounded paired captions and clears retired language content', async () => {
  const f = setup(); await f.join(); assert.equal(f.app.phase, 'connected');
  const joined = initial(), sourceId = '44444444-4444-4444-8444-444444444444'; let sequence = 0;
  const context = joined.configuration.context;
  const base = revision => ({ protocolVersion: 1, projectId: context.projectId, sessionId: context.sessionId,
    participantId: context.participantId, memberGeneration: context.memberGeneration, retention: context.retention,
    workerGeneration: 3, subscriptionRevision: revision });
  const event = value => f.callbacks().text(joined.grant.processor_identity, JSON.stringify(value));
  const applied = (revision, language) => event({ ...base(revision), type: 'subscription_applied', targetLanguage: language, mode: 'translated' });
  const caption = (unit, text, final, targetLanguage, revision = 1) => {
    const record = { protocolVersion: 1, projectId: joined.configuration.context.projectId, sessionId: joined.grant.session_id,
      retention: 'live_only', sourceId, sourceEpoch: 1, sourceParticipantId: joined.peer.participantId, sourceMemberGeneration: 2,
      unitId: `${sourceId}:1:1:${unit}`, sourceFirstSeq: unit, sourceLastSeq: unit, startMs: unit * 100, endMs: unit * 100 + 100,
      sourceLanguage: 'en', text, ...(targetLanguage ? { targetLanguage } : {}) };
    event({ ...base(revision), type: 'caption', eventSequence: ++sequence, sourceId, sourceEpoch: 1,
      sourceParticipantId: joined.peer.participantId, sourceMemberGeneration: 2, record, final });
  };
  try {
    applied(1, 'zh'); caption(1, 'Original', true); caption(1, 'Translation', true, 'zh'); caption(1, 'Late draft', false);
    assert.equal(f.app.pairs.length, 1); assert.equal(f.app.pairs[0].original.record.text, 'Original');
    assert.equal(f.app.pairs[0].translation.record.text, 'Translation');
    for (let i = 2; i <= 105; i++) caption(i, `Passage ${i}`, true);
    assert.equal(f.app.pairs.length, 100);
    await f.app.select('ja', 'translated'); assert.equal(f.app.pairs.length, 0);
    caption(106, 'Old language', true, 'zh'); assert.equal(f.app.pairs.length, 0);
    applied(2, 'ja'); caption(107, 'Current language', true, 'ja', 2);
    assert.equal(f.app.pairs[0].translation.record.text, 'Current language');
  } finally { await f.app.leave(); }
  assert.equal(f.app.pairs.length, 0);
});
