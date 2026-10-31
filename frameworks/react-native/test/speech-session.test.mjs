import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('../../../protocol/speech-session/client-v1.json', import.meta.url), 'utf8'));

test('optional speech entry executes generated Rust without WebAssembly or native recording bytes', async () => {
  const previous = globalThis.WebAssembly;
  globalThis.WebAssembly = undefined;
  let session;
  let capture = false;
  try {
    const { createNativeSpeechSession } = require('../lib/commonjs/speech.js');
    session = createNativeSpeechSession({
      configuration: fixture.configuration,
      grant: { ...fixture.grant, expires_at: new Date(Date.now() + 60_000).toISOString() },
      host: { renewGrant: async () => { throw Error('unused'); }, changeSubscription: async () => { throw Error('unused'); } },
      mediaFactory: () => ({ async connect() {}, silencePlayback() {}, muteMicrophone() { capture = false; },
        async clearPlayback() {}, async setPlayback() {}, async setMicrophone(enabled) { capture = enabled; }, async close() {} }),
    });
    await session.ready;
    await session.setMicrophone(true);
    assert.equal(capture, true);
    await session.setListening(false);
    assert.equal(capture, true);
    assert.equal(session.state.canCapture, true);
  } finally { await session?.close(); globalThis.WebAssembly = previous; }
  assert.equal(capture, false);
});

test('generated Rust accepts early applied revisions and rejects old language audio', async () => {
  const { createNativeSpeechSession } = require('../lib/commonjs/speech.js');
  const { context, subscription } = fixture.configuration;
  let callbacks;
  let tracks = [];
  let capture = false;
  const envelope = revision => ({ protocolVersion: 1, projectId: context.projectId, sessionId: context.sessionId,
    retention: context.retention, participantId: context.participantId, memberGeneration: context.memberGeneration,
    workerGeneration: 3, subscriptionRevision: revision });
  const event = value => callbacks.text(fixture.grant.processor_identity, JSON.stringify(value));
  const audio = (revision, targetLanguage) => ({ ...envelope(revision), type: 'audio_start', eventSequence: 1,
    sourceId: '44444444-4444-4444-8444-444444444444', sourceEpoch: 1,
    sourceParticipantId: subscription.sourceParticipantIds[0], sourceMemberGeneration: 1,
    unitId: 'unit_1', outputId: 'output_1', transport: 'webrtc', codec: 'opus', sourceSampleRate: 24000,
    channels: 1, origin: 'generated', voice: 'neutral', mediaTrackSid: `TR_${targetLanguage}`, targetLanguage });
  const session = createNativeSpeechSession({
    configuration: fixture.configuration,
    grant: { ...fixture.grant, expires_at: new Date(Date.now() + 60_000).toISOString() },
    host: {
      renewGrant: async () => { throw Error('unused'); },
      changeSubscription: async selection => {
        event({ ...envelope(2), type: 'subscription_applied', targetLanguage: 'ja', mode: 'translated' });
        return { ...selection, revision: 2 };
      },
    },
    mediaFactory: value => {
      callbacks = value;
      return { async connect() {}, silencePlayback() { tracks = []; }, muteMicrophone() { capture = false; },
        async clearPlayback() { tracks = []; }, async setPlayback(value) { tracks = [...value]; },
        async setMicrophone(enabled) { capture = enabled; }, async close() {} };
    },
  });
  try {
    await session.ready; await session.setMicrophone(true); await session.setListening(true);
    await session.changeSubscription({ targetLanguage: 'ja', mode: 'translated', sourceParticipantIds: subscription.sourceParticipantIds });
    event(audio(1, 'zh')); await session.setListening(true);
    assert.deepEqual(tracks, []);
    event(audio(2, 'ja')); await session.setListening(true);
    assert.equal(tracks[0].mediaTrackSid, 'TR_ja');
    assert.equal(capture, true);
    assert.equal(session.state.subscriptionRevision, 2);
    assert.ok(!JSON.stringify(session.state).includes(fixture.grant.token));
  } finally { await session.close(); }
});
