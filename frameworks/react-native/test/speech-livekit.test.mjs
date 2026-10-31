import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test as nodeTest } from 'node:test';

const test = (name, body) => nodeTest(name, { timeout: 5_000 }, body);

const require = createRequire(import.meta.url);
const factory = (...args) => require('../lib/commonjs/speechLiveKit.js').createLiveKitNativeMedia(...args);
const grant = { protocol_version: 1, provider: 'livekit', url: 'wss://synthetic.livekit.cloud', token: 'synthetic',
  room: 'synthetic-room', identity: 'synthetic-member', processor_identity: 'synthetic-worker', expires_at: '',
  session_id: '', participant_id: '', member_generation: 1, worker_generation: 1 };
const signal = () => new AbortController().signal;
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

test('native media public subpath imports without a vendor runtime or native module', () => {
  const entry = require('@bota.dev/react-native-app-sdk/speech/livekit');
  assert.equal(typeof entry.createLiveKitNativeMedia, 'function');
});
function fixture(roomGrant = grant) {
  const actions = [], events = [];
  let defaultVolume = 0.7, volume = 0, started = false, stops = 0;
  const local = { mediaStreamTrack: { enabled: true }, stop() { this.mediaStreamTrack.enabled = false; actions.push('mic-stop'); } };
  const remote = { kind: 'audio', setVolume(value) { volume = value; actions.push(`track-volume:${value}`); } };
  const publication = { kind: 'audio', trackSid: 'TR_test', desired: false,
    setSubscribed(value) { this.desired = value; actions.push(`subscribe:${value}`); } };
  const participant = { identity: roomGrant.processor_identity, trackPublications: new Map([['TR_test', publication]]) };
  class FakeRoom extends EventEmitter {
    name = roomGrant.room;
    localParticipant = { identity: roomGrant.identity,
      publishTrack: async () => { actions.push('publish'); return { trackSid: 'TR_original' }; }, unpublishTrack: async () => { actions.push('unpublish'); } };
    remoteParticipants = new Map([[participant.identity, participant]]);
    async connect(_url, _token, options) {
      assert.equal(started, true); assert.equal(defaultVolume, 0);
      assert.equal(options.autoSubscribe, false); assert.equal(options.maxRetries, 0);
      actions.push('connect');
    }
    async disconnect() { actions.push('disconnect'); }
    registerTextStreamHandler(_topic, handler) { this.handler = handler; }
    unregisterTextStreamHandler() { this.handler = undefined; }
  }
  const room = new FakeRoom();
  const audioSession = {
    async configureAudio(config) {
      assert.equal(config.android.audioTypeOptions.audioMode, 'inCommunication');
      assert.deepEqual(config.android.preferredOutputList, ['bluetooth', 'headset', 'earpiece', 'speaker']);
      assert.equal(config.ios.defaultOutput, 'earpiece'); actions.push('configure');
    },
    async setDefaultRemoteAudioTrackVolume(value) { defaultVolume = value; actions.push(`default-volume:${value}`); },
    async startAudioSession() { started = true; actions.push('start-session'); },
    async stopAudioSession() { started = false; stops++; actions.push('stop-session'); },
  };
  const callbacks = { text: (_sender, text) => events.push(text), trackRemoved: () => events.push('removed'),
    disconnected: () => events.push('disconnected'), failed: () => events.push('failed'), playbackBlocked: () => events.push('blocked') };
  const deps = { roomFactory: () => room, createMicrophone: async () => local, silenceVendorLogs() {},
    audioSession, audioSessionOwnership: 'exclusive', restoreRemoteTrackVolume: 0.7, defaultOutput: 'earpiece' };
  const tracks = [{ mediaTrackSid: 'TR_test', sourceId: 'source', sourceEpoch: 1, sourceParticipantId: 'speaker', origin: 'generated', outputId: 'output' }];
  return { actions, events, room, local, remote, publication, participant, audioSession, callbacks, deps, tracks,
    get started() { return started; }, get stops() { return stops; }, get defaultVolume() { return defaultVolume; }, get volume() { return volume; },
    subscribe() { volume = defaultVolume; room.emit('trackSubscribed', remote, publication, participant); },
    unsubscribe() { room.emit('trackUnsubscribed', remote, publication, participant); },
  };
}

test('native finish holds a late acquisition muted and preserves the exact published SID', async () => {
  const f = fixture(), acquired = deferred(); f.deps.createMicrophone = () => acquired.promise;
  const port = factory(f.callbacks, f.deps); await port.connect(grant, signal());
  const capture = port.setMicrophone(true, signal()); port.holdMicrophone();
  acquired.resolve(f.local); await capture;
  assert.equal(f.local.mediaStreamTrack.enabled, false); assert.equal(port.microphonePublication(), 'TR_original');
  assert.equal(f.actions.includes('unpublish'), false); assert.equal(f.actions.includes('mic-stop'), false);
  assert.equal(f.started, true);
  await port.setMicrophone(false, signal()); assert.equal(port.microphonePublication(), null);
  assert.equal(f.actions.includes('unpublish'), true); assert.equal(f.started, true);
  await port.close(); assert.equal(f.started, false);
});

test('native session starts with muted incoming tracks and admits only the selected processor audio', async () => {
  const f = fixture(), port = factory(f.callbacks, f.deps);
  try {
    await port.connect(grant, signal()); await port.setMicrophone(true, signal());
    f.subscribe(); assert.equal(f.volume, 0);
    await port.setPlayback(f.tracks, signal()); assert.equal(f.volume, 1);
    port.silencePlayback(); assert.equal(f.volume, 0); assert.equal(f.local.mediaStreamTrack.enabled, true);
    f.subscribe(); assert.equal(f.volume, 0, 'late old-track arrival cannot start playback');
    assert.equal(f.stops, 0, 'listening changes must not stop the native audio session');
  } finally { await port.close(); }
  assert.equal(f.started, false); assert.equal(f.defaultVolume, 0.7); assert.equal(f.local.mediaStreamTrack.enabled, false);
  assert.ok(f.actions.indexOf('disconnect') < f.actions.indexOf('stop-session'));
});

test('native buffer clear joins the exact remote unsubscribe before acknowledging', async () => {
  const f = fixture(), port = factory(f.callbacks, f.deps);
  try {
    await port.connect(grant, signal()); await port.setPlayback(f.tracks, signal()); f.subscribe();
    let done = false;
    const clearing = port.clearPlayback(signal()).then(() => { done = true; });
    assert.equal(done, false); assert.equal(f.volume, 0); assert.equal(f.publication.desired, false);
    f.room.emit('trackUnsubscribed', { kind: 'audio' }, f.publication, f.participant);
    assert.equal(done, false);
    f.unsubscribe(); await clearing; assert.equal(done, true);
  } finally { await port.close(); }
});

test('closing during native session start joins it before stopping and never connects later', async () => {
  const f = fixture(), entered = deferred(), released = deferred();
  const start = f.audioSession.startAudioSession;
  f.audioSession.startAudioSession = async () => { entered.resolve(); await released.promise; await start(); };
  const port = factory(f.callbacks, f.deps);
  const connecting = assert.rejects(port.connect(grant, signal()), /media_failed|closed/);
  await entered.promise;
  const closing = port.close();
  assert.equal(f.stops, 0);
  released.resolve(); await connecting; await closing;
  assert.equal(f.started, false); assert.equal(f.actions.includes('connect'), false); assert.equal(f.stops, 1);
});

test('one native audio-session owner prevents concurrent global mutation and releases only after cleanup', async () => {
  const f = fixture(), port = factory(f.callbacks, f.deps);
  await port.connect(grant, signal());
  const second = fixture(), other = factory(second.callbacks, { ...second.deps, audioSession: f.audioSession });
  await assert.rejects(other.connect(grant, signal()), /media_failed/);
  assert.equal(f.stops, 0); assert.equal(f.started, true);
  await other.close(); await port.close();
  const third = factory(f.callbacks, f.deps);
  await third.connect(grant, signal()); await third.close();
  assert.equal(f.stops, 2);
});

test('native close drains a late microphone acquisition and prevents its publication', async () => {
  const f = fixture(), acquired = deferred(), entered = deferred();
  const port = factory(f.callbacks, { ...f.deps, createMicrophone: async () => { entered.resolve(); return acquired.promise; } });
  await port.connect(grant, signal());
  const starting = port.setMicrophone(true, signal()); await entered.promise;
  const closing = port.close(); acquired.resolve(f.local);
  await starting; await closing;
  assert.equal(f.actions.includes('publish'), false); assert.equal(f.local.mediaStreamTrack.enabled, false); assert.equal(f.started, false);
});

test('an incompatible acquired microphone is stopped before it can escape native cleanup', async () => {
  const f = fixture();
  f.local.mediaStreamTrack.enabled = 'incompatible';
  const port = factory(f.callbacks, f.deps);
  await port.connect(grant, signal());
  await assert.rejects(port.setMicrophone(true, signal()), /media_failed/);
  assert.equal(f.local.mediaStreamTrack.enabled, false);
  await port.close();
});

test('native source identities and reconnect callbacks cannot reopen an old owner', async () => {
  const f = fixture(), port = factory(f.callbacks, f.deps);
  await port.connect(grant, signal()); await port.setMicrophone(true, signal());
  await port.setPlayback(f.tracks, signal()); f.subscribe();
  const late = f.room.listeners('trackSubscribed')[0];
  f.room.emit('reconnecting'); await port.close();
  late(f.remote, f.publication, f.participant); assert.equal(f.volume, 0);
  assert.equal(f.local.mediaStreamTrack.enabled, false); assert.ok(f.events.includes('disconnected'));
});

test('failed native cleanup retains ownership and never restores audible defaults', async () => {
  const f = fixture(), port = factory(f.callbacks, f.deps);
  await port.connect(grant, signal());
  f.audioSession.stopAudioSession = async () => { throw Error('synthetic-vendor-private-material'); };
  await assert.rejects(port.close(), error => error.code === 'cleanup_failed' && !error.message.includes('private-material'));
  assert.equal(f.defaultVolume, 0);
  const other = fixture(), candidate = factory(other.callbacks, { ...other.deps, audioSession: f.audioSession });
  await assert.rejects(candidate.connect(grant, signal()), /media_failed/);
  assert.equal(other.actions.includes('connect'), false);
  await candidate.close();
});

test('startup failure stops the attempted native session and does not connect or capture', async () => {
  const f = fixture();
  f.audioSession.startAudioSession = async () => { throw Error('native start failed'); };
  const port = factory(f.callbacks, f.deps);
  await assert.rejects(port.connect(grant, signal()), /media_failed/);
  await port.close();
  assert.equal(f.stops, 1); assert.equal(f.defaultVolume, 0.7);
  assert.equal(f.actions.includes('connect'), false); assert.equal(f.actions.includes('publish'), false);
});

test('a vendor connection completing after cancellation is disconnected before audio ownership is released', async () => {
  const f = fixture(), entered = deferred(), connected = deferred(), disconnected = deferred();
  const disconnect = f.room.disconnect.bind(f.room);
  f.room.connect = async () => { entered.resolve(); await connected.promise; f.actions.push('late-connect'); };
  f.room.disconnect = async () => { await disconnect(); disconnected.resolve(); };
  const port = factory(f.callbacks, f.deps);
  const joining = assert.rejects(port.connect(grant, signal()), /media_failed/);
  await entered.promise;
  const closing = port.close(); await disconnected.promise;
  assert.equal(f.stops, 0);
  connected.resolve(); await joining; await closing;
  assert.ok(f.actions.lastIndexOf('disconnect') > f.actions.indexOf('late-connect'));
  assert.ok(f.actions.indexOf('stop-session') > f.actions.lastIndexOf('disconnect'));
});

test('native metadata is bounded and only accepted from the granted processor', async () => {
  const f = fixture(), port = factory(f.callbacks, f.deps);
  await port.connect(grant, signal());
  const reader = { withAbortSignal(abort) { this.abort = abort; return this; },
    async *[Symbol.asyncIterator]() { if (!this.abort.aborted) yield 'safe metadata'; } };
  const received = deferred();
  f.callbacks.text = (_sender, text) => { f.events.push(text); received.resolve(); };
  f.room.handler(reader, { identity: grant.processor_identity }); await received.promise;
  assert.deepEqual(f.events, ['safe metadata']);
  const foreign = { ...reader, async *[Symbol.asyncIterator]() { yield 'foreign'; } };
  f.room.handler(foreign, { identity: 'foreign-processor' });
  assert.equal(foreign.abort.aborted, true);
  await port.setPlayback(f.tracks, signal());
  f.room.emit('trackSubscribed', f.remote, f.publication, { identity: 'foreign-processor' });
  assert.equal(f.volume, 0); assert.equal(f.publication.desired, false);
  const rejected = deferred();
  f.callbacks.failed = () => { f.events.push('failed'); rejected.resolve(); };
  f.room.handler({ ...reader, async *[Symbol.asyncIterator]() { yield '\u6f22'.repeat(11_000); } }, { identity: grant.processor_identity });
  await rejected.promise;
  assert.deepEqual(f.events, ['safe metadata', 'failed']);
  await port.close();
});

test('generated Rust and native media adapter preserve capture through language changes', async () => {
  const { createNativeSpeechSession } = require('../lib/commonjs/speech.js');
  const protocol = JSON.parse(readFileSync(new URL('../../../protocol/speech-session/client-v1.json', import.meta.url), 'utf8'));
  const currentGrant = { ...protocol.grant, expires_at: new Date(Date.now() + 60_000).toISOString() };
  const f = fixture(currentGrant), context = protocol.configuration.context;
  let callbacks;
  const envelope = revision => ({ protocolVersion: 1, projectId: context.projectId, sessionId: context.sessionId,
    retention: context.retention, participantId: context.participantId, memberGeneration: context.memberGeneration,
    workerGeneration: currentGrant.worker_generation, subscriptionRevision: revision });
  const emit = value => callbacks.text(currentGrant.processor_identity, JSON.stringify(value));
  const applied = (revision, language) => emit({ ...envelope(revision), type: 'subscription_applied', mode: 'translated', targetLanguage: language });
  const audio = (revision, language) => emit({ ...envelope(revision), type: 'audio_start', eventSequence: 1,
    sourceId: '44444444-4444-4444-8444-444444444444', sourceEpoch: 1,
    sourceParticipantId: protocol.configuration.subscription.sourceParticipantIds[0], sourceMemberGeneration: 1,
    unitId: 'unit_1', outputId: 'output_1', transport: 'webrtc', codec: 'opus', sourceSampleRate: 24000,
    channels: 1, origin: 'generated', voice: 'neutral', mediaTrackSid: 'TR_test', targetLanguage: language });
  const client = createNativeSpeechSession({ configuration: protocol.configuration, grant: currentGrant,
    host: { renewGrant: async () => currentGrant, changeSubscription: async selection => { applied(2, 'ja'); return { ...selection, revision: 2 }; } },
    mediaFactory: value => { callbacks = value; return factory(value, f.deps); },
  });
  try {
    await client.ready; await client.setMicrophone(true); await client.setListening(true);
    applied(1, 'zh'); audio(1, 'zh'); await client.setListening(true); f.subscribe();
    assert.equal(f.volume, 1); assert.equal(f.local.mediaStreamTrack.enabled, true);
    const changing = client.changeSubscription({ targetLanguage: 'ja', mode: 'translated', sourceParticipantIds: protocol.configuration.subscription.sourceParticipantIds });
    assert.equal(f.volume, 0); assert.equal(f.local.mediaStreamTrack.enabled, true);
    f.unsubscribe(); await changing; await client.setListening(true);
    audio(1, 'zh'); await client.setListening(true); f.subscribe(); assert.equal(f.volume, 0); f.unsubscribe();
    audio(2, 'ja'); await client.setListening(true); f.subscribe(); assert.equal(f.volume, 1);
    assert.equal(f.stops, 0); assert.equal(client.state.canCapture, true);
  } finally { await client.close(); }
  assert.equal(f.started, false);
});

test('native LiveKit finish executes generated Rust, retires only capture and keeps the audio session alive', async () => {
  const vector = JSON.parse(readFileSync(new URL('../../../protocol/speech-session/client-v1.json', import.meta.url), 'utf8'));
  const scoped = { ...vector.grant, expires_at: new Date(Date.now() + 60_000).toISOString() };
  const f = fixture(scoped), requests = [];
  const previous = globalThis.WebAssembly; let session;
  try {
    globalThis.WebAssembly = undefined;
    session = require('../lib/commonjs/speech.js').createNativeSpeechSession({
      configuration: vector.configuration, grant: scoped,
      mediaFactory: callbacks => factory(callbacks, f.deps),
      host: { renewGrant: async () => scoped, changeSubscription: async () => { throw Error('unused'); },
        finishSource: async request => {
          requests.push(request);
          return { source: { id: '44444444-4444-4444-8444-444444444444', epoch: 1,
            participant_id: scoped.participant_id, member_generation: scoped.member_generation, track_sid: 'TR_original', state: 'ended',
            finish: { state: 'completed', worker_generation: scoped.worker_generation, sequence: '1', samples: '1600' } } };
        } },
    });
    await session.ready; await session.setMicrophone(true);
    const finishing = session.finishMicrophone(); assert.equal(f.local.mediaStreamTrack.enabled, false);
    assert.equal((await finishing).status, 'completed'); assert.equal(requests.length, 1);
    assert.equal(requests[0].trackSid, 'TR_original'); assert.equal(requests[0].workerGeneration, 3);
    assert.equal(f.actions.filter(value => value === 'unpublish').length, 1);
    assert.equal(f.started, true); assert.equal(f.actions.includes('disconnect'), false);
    assert.equal(session.state.connected, true); assert.equal(session.state.canCapture, false);
  } finally { await session?.close(); globalThis.WebAssembly = previous; }
  assert.equal(f.started, false);
});
