import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import init, { WebSpeechClient } from '../generated/bota_device_sdk_core.js'
import { createSpeechSession } from '../../../shared/speechHost.ts'
import type { SpeechMediaCallbacks, SpeechMediaPort, SpeechSubscription, SpeechUpdate } from '../../../shared/speechHost.ts'

const fixture = JSON.parse(await readFile(new URL('../../../../protocol/speech-session/client-v1.json', import.meta.url), 'utf8'))
await init({ module_or_path: await readFile(new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url)) })
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function applied(revision = 1, targetLanguage = 'zh') {
  const { context } = fixture.configuration
  return { protocolVersion: 1, projectId: context.projectId, sessionId: context.sessionId,
    retention: context.retention, participantId: context.participantId, memberGeneration: context.memberGeneration,
    workerGeneration: 3, subscriptionRevision: revision, targetLanguage, mode: 'translated', type: 'subscription_applied' }
}
function audio(revision = 1, targetLanguage = 'zh', sequence = 1) {
  const { mode: _, ...base } = applied(revision, targetLanguage)
  return { ...base, type: 'audio_start', eventSequence: sequence,
    sourceId: '44444444-4444-4444-8444-444444444444', sourceEpoch: 1,
    sourceParticipantId: fixture.configuration.subscription.sourceParticipantIds[0], sourceMemberGeneration: 1,
    unitId: 'unit_1', outputId: 'output_1', transport: 'webrtc', codec: 'opus', sourceSampleRate: 24000,
    channels: 1, origin: 'generated', voice: 'neutral', mediaTrackSid: `TR_${targetLanguage}` }
}
function setup(overrides: Partial<SpeechMediaPort> = {}) {
  let callbacks!: SpeechMediaCallbacks
  let tick = () => {}
  let now = fixture.nowMs
  let creates = 0
  let microphone = false
  let tracks: string[] = []
  let closed = 0
  let nextSubscription = deferred<SpeechSubscription>()
  const errors: string[] = []
  const states: SpeechUpdate[] = []
  const port: SpeechMediaPort = {
    async connect() {},
    silencePlayback() { tracks = [] },
    muteMicrophone() { microphone = false },
    async clearPlayback() { tracks = [] },
    async setPlayback(value) { tracks = value.map(t => t.mediaTrackSid) },
    async setMicrophone(enabled) { microphone = enabled },
    async close() { closed++ },
    ...overrides,
  }
  const options = {
    configuration: fixture.configuration, grant: fixture.grant,
    policyFactory(configuration: string, grant: string, at: number) {
      const core = new WebSpeechClient(configuration, grant, at)
      return { step: (command: string, time: number) => JSON.parse(core.step(command, time)), dispose: () => core.free() }
    },
    mediaFactory(value: SpeechMediaCallbacks) { callbacks = value; creates++; return port },
    host: {
      changeSubscription: async () => nextSubscription.promise,
      renewGrant: async () => fixture.grant,
    },
    clock: { now: () => now, every: (_ms: number, callback: () => void) => { tick = callback; return () => { tick = () => {} } } },
    onError: (error: { code: string }) => errors.push(error.code),
    onState: (value: SpeechUpdate) => states.push(value),
  }
  return { options, port, errors, states, get creates() { return creates }, get microphone() { return microphone },
    get tracks() { return tracks }, get closed() { return closed },
    event(value: unknown) { callbacks.text(fixture.grant.processor_identity, JSON.stringify(value)) },
    advance(ms: number) { now += ms; tick() },
    resolveSubscription(revision: number, targetLanguage: string) {
      nextSubscription.resolve({ ...fixture.configuration.subscription, revision, targetLanguage })
      nextSubscription = deferred<SpeechSubscription>()
    },
  }
}

test('invalid grant is rejected by the real core before media construction', () => {
  const f = setup()
  assert.throws(() => createSpeechSession({ ...f.options, grant: { ...fixture.grant, url: 'wss://foreign.example' } }), /invalid_input/)
  assert.equal(f.creates, 0)
})

test('real core gates language playback on host, worker and platform while capture continues', async () => {
  const f = setup()
  const client = createSpeechSession(f.options)
  try {
    await client.ready
    await client.setMicrophone(true)
    await client.setListening(true)
    f.event(applied()); f.event(audio()); await client.setListening(true)
    assert.deepEqual(f.tracks, ['TR_zh'])
    const clear = deferred()
    f.port.clearPlayback = async () => clear.promise
    const changing = client.changeSubscription({ targetLanguage: 'ja', mode: 'translated', sourceParticipantIds: fixture.configuration.subscription.sourceParticipantIds })
    assert.deepEqual(f.tracks, [])
    assert.equal(f.microphone, true)
    f.event(applied(2, 'ja'))
    f.resolveSubscription(2, 'ja')
    await changing
    f.event(audio(2, 'ja'))
    assert.equal(client.state.canPlay, false)
    assert.deepEqual(f.tracks, [])
    clear.resolve(); await client.setListening(true)
    assert.deepEqual(f.tracks, ['TR_ja'])
    await client.setListening(false)
    assert.equal(f.microphone, true)
    assert.deepEqual(f.tracks, [])
  } finally { await client.close() }
})

test('superseded HTTP replies cannot undo the newest language selection', async () => {
  const f = setup()
  const client = createSpeechSession(f.options)
  try {
    await client.ready; await client.setListening(true)
    const old = client.changeSubscription({ ...fixture.configuration.subscription, targetLanguage: 'ja' })
    const rejected = assert.rejects(old, /superseded/)
    f.resolveSubscription(2, 'ja')
    const current = client.changeSubscription({ ...fixture.configuration.subscription, targetLanguage: 'en' })
    f.event(applied(3, 'en')); f.resolveSubscription(3, 'en')
    await current; await rejected; await client.setListening(true)
    f.event(audio(2, 'ja')); await client.setListening(true)
    assert.deepEqual(f.tracks, [])
    f.event(audio(3, 'en')); await client.setListening(true)
    assert.deepEqual(f.tracks, ['TR_en'])
  } finally { await client.close() }
})

test('closing during connect retires the owner before the connection callback', async () => {
  const connection = deferred()
  const f = setup({ connect: async () => connection.promise })
  const client = createSpeechSession(f.options)
  const rejected = assert.rejects(client.ready, /closed/)
  await client.close()
  connection.resolve(); await rejected
  f.event(applied()); f.event(audio()); await client.close()
  assert.deepEqual(f.tracks, [])
  assert.equal(f.microphone, false)
  assert.equal(f.closed, 1)
})

test('grant expiration stops both directions even without a media disconnect event', async () => {
  const f = setup()
  const client = createSpeechSession(f.options)
  await client.ready; await client.setMicrophone(true); await client.setListening(true)
  f.event(applied()); f.event(audio()); await client.setListening(true)
  f.advance(60_000); await client.close()
  assert.equal(f.microphone, false)
  assert.deepEqual(f.tracks, [])
  assert.equal(f.closed, 1)
  await assert.rejects(client.setListening(true), /closed/)
  await client.close()
})

test('media failures expose fixed codes and retire resources without echoing vendor secrets', async () => {
  const f = setup({ setMicrophone: async enabled => { if (enabled) throw new Error('Bearer synthetic-private-material') } })
  const client = createSpeechSession(f.options)
  await client.ready
  await assert.rejects(client.setMicrophone(true), /media_failed/)
  await client.close()
  assert.equal(f.closed, 1)
  assert.ok(!JSON.stringify(f.errors).includes('synthetic-private'))
})

test('closing in a state observer prevents content delivery after teardown', async () => {
  const f = setup()
  let emitted = 0
  const client = createSpeechSession({ ...f.options, onEvent: () => { emitted++ },
    onState: state => { if (state.tracks.length) void client.close() } })
  await client.ready; await client.setListening(true)
  f.event(applied()); await client.setListening(true)
  emitted = 0
  f.event(audio()); await client.close()
  assert.equal(emitted, 0)
  assert.equal(f.closed, 1)
  await client.close()
})
