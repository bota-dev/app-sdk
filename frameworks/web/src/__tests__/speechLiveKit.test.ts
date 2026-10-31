import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createRequire } from 'node:module'
import { createLiveKitWebMedia } from '../speechLiveKit.ts'
import type { SpeechMediaCallbacks, SpeechTrack } from '../../../shared/speechHost.ts'
// Exercise the installed runtime's actual enum values without importing its
// incompatible exact-optional declarations into the SDK's strict public surface.
const { RoomEvent, Track } = createRequire(import.meta.url)('livekit-client')

const grant = { protocol_version: 1, provider: 'livekit', url: 'wss://synthetic.livekit.cloud', token: 'synthetic',
  room: 'synthetic-room', identity: 'synthetic-member', processor_identity: 'synthetic-worker', expires_at: '',
  session_id: 'synthetic-session', participant_id: 'synthetic-participant', member_generation: 1, worker_generation: 1 }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
function fake() {
  let published = 0, stopped = 0, attaches = 0, plays = 0, disconnects = 0
  const elements: HTMLMediaElement[] = []
  const remote = { kind: Track.Kind.Audio, setVolume() {},
    attach(element: HTMLMediaElement) { attaches++; elements.push(element); return element },
    detach() { return elements.splice(0) },
  }
  const participant = { identity: grant.processor_identity, trackPublications: new Map() }
  const publication = { trackSid: 'TR_test', kind: Track.Kind.Audio, track: undefined as unknown,
    desired: false, setSubscribed(value: boolean) { this.desired = value } }
  participant.trackPublications.set('TR_test', publication)
  const local = { mediaStreamTrack: { enabled: true }, stop() { stopped++ } }
  class FakeRoom extends EventEmitter {
    name = grant.room
    canPlaybackAudio = true
    localParticipant = { identity: grant.identity, publishTrack: async () => { published++; return { trackSid: 'TR_original' } }, unpublishTrack: async () => {} }
    remoteParticipants = new Map([[participant.identity, participant]])
    handler: ((...args: unknown[]) => void) | undefined
    async connect(_url: string, _token: string, options: { autoSubscribe: boolean; maxRetries: number }) {
      assert.equal(options.autoSubscribe, false); assert.equal(options.maxRetries, 0)
    }
    async disconnect() { disconnects++ }
    async startAudio() {}
    registerTextStreamHandler(_topic: string, handler: (...args: unknown[]) => void) { this.handler = handler }
    unregisterTextStreamHandler() { this.handler = undefined }
  }
  const room = new FakeRoom()
  const events: string[] = []
  const callbacks: SpeechMediaCallbacks = { text: () => { events.push('text') }, trackRemoved: () => { events.push('removed') },
    disconnected: () => { events.push('disconnected') }, failed: () => { events.push('failed') }, playbackBlocked: () => {} }
  const deps = {
    roomFactory: () => room,
    createMicrophone: async () => local,
    silenceVendorLogs() {},
    createAudioElement: () => ({ muted: true, autoplay: false, srcObject: null,
      pause() {}, remove() {}, play: async () => { plays++ },
    }) as unknown as HTMLAudioElement,
  }
  const admitted: SpeechTrack[] = [{ mediaTrackSid: 'TR_test', sourceId: 'source', sourceEpoch: 1,
    sourceParticipantId: 'speaker', origin: 'generated', outputId: 'output' }]
  return { room, remote, participant, publication, local, events, callbacks, deps, admitted,
    get published() { return published }, get stopped() { return stopped }, get attaches() { return attaches },
    get plays() { return plays }, get disconnects() { return disconnects },
    subscribe() { publication.track = remote; room.emit(RoomEvent.TrackSubscribed, remote, publication, participant) },
    unsubscribe() { publication.track = undefined; room.emit(RoomEvent.TrackUnsubscribed, remote, publication, participant) },
  }
}

test('source finish holds a late microphone acquisition muted until normal source retirement', async () => {
  const f = fake(), acquired = deferred<typeof f.local>(), signal = new AbortController().signal
  f.deps.createMicrophone = async () => acquired.promise
  let removed = 0
  f.room.localParticipant.unpublishTrack = async () => { removed++ }
  const port = createLiveKitWebMedia(f.callbacks, f.deps)
  await port.connect(grant, signal)
  const capture = port.setMicrophone(true, signal)
  port.holdMicrophone!()
  acquired.resolve(f.local); await capture
  assert.equal(f.local.mediaStreamTrack.enabled, false)
  assert.equal(port.microphonePublication!(), 'TR_original')
  assert.equal(removed, 0); assert.equal(f.stopped, 0); assert.equal(f.disconnects, 0)
  await port.setMicrophone(false, signal)
  assert.equal(removed, 1); assert.equal(port.microphonePublication!(), null)
  await port.close()
})

function audioGraph(original: MediaStreamTrack, branch: unknown) {
  let closes = 0
  const stream = {} as MediaStream
  const context = {
    state: 'suspended',
    createMediaStreamSource(value: MediaStream) { assert.equal(value, stream); return { connect() {}, disconnect() {} } },
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [branch] }, disconnect() {} } },
    async resume() { this.state = 'running' },
    async close() { this.state = 'closed'; closes++ },
  }
  return { context, get closes() { return closes }, deps: {
    createAudioContext: () => context as unknown as AudioContext,
    createMediaStream: (tracks: MediaStreamTrack[]) => { assert.deepEqual(tracks, [original]); return stream },
  } }
}

test('external Web input publishes an owned audio branch and never stops or mutes the host track', async () => {
  const f = fake(), signal = new AbortController().signal
  let originalStops = 0, cloneStops = 0, microphoneCalls = 0
  const branch = { id: 'branch', kind: 'audio', readyState: 'live', enabled: true, stop() { if (this.readyState !== 'ended') cloneStops++; this.readyState = 'ended' } }
  const original = { id: 'original', kind: 'audio', readyState: 'live', enabled: true,
    clone: () => branch, stop() { originalStops++ } } as unknown as MediaStreamTrack
  const graph = audioGraph(original, branch)
  const port = createLiveKitWebMedia(f.callbacks, { ...f.deps, ...graph.deps,
    createMicrophone: async () => { microphoneCalls++; return f.local },
    externalInput: { participantId: grant.participant_id, memberGeneration: 1, track: original,
      wrapTrack: track => ({ mediaStreamTrack: track, stop: () => track.stop() }) },
  })
  await port.connect(grant, signal); await port.setMicrophone(true, signal)
  assert.equal(f.published, 1); assert.equal(microphoneCalls, 0)
  port.holdMicrophone!(); assert.equal(branch.enabled, false); assert.equal(original.enabled, true)
  assert.equal(port.microphonePublication!(), 'TR_original')
  await port.setMicrophone(false, signal)
  assert.equal(originalStops, 0); assert.equal(cloneStops, 1); assert.equal(f.disconnects, 0)
  await port.close(); assert.equal(original.enabled, true); assert.equal(originalStops, 0); assert.equal(graph.closes, 1)
})

test('external Web input refuses another member before capture and refuses a borrowed wrapper without touching it', async () => {
  const f = fake(), signal = new AbortController().signal
  let cloneStops = 0, originalStops = 0
  const branch = { id: 'branch', kind: 'audio', readyState: 'live', enabled: true, stop() { if (this.readyState !== 'ended') cloneStops++; this.readyState = 'ended' } }
  const original = { id: 'original', kind: 'audio', readyState: 'live', enabled: true, clone: () => branch,
    stop() { originalStops++ } } as unknown as MediaStreamTrack
  const externalInput = { participantId: 'another-member', memberGeneration: 1, track: original,
    wrapTrack: () => ({ mediaStreamTrack: original, stop: () => original.stop() }) }
  const other = createLiveKitWebMedia(f.callbacks, { ...f.deps, externalInput })
  await assert.rejects(other.connect(grant, signal), /invalid_input|media_failed/)
  assert.equal(f.published, 0); assert.equal(originalStops, 0)
  await other.close()
  const fresh = fake()
  const graph = audioGraph(original, branch)
  const port = createLiveKitWebMedia(fresh.callbacks, { ...fresh.deps, ...graph.deps, externalInput: { ...externalInput, participantId: grant.participant_id } })
  await port.connect(grant, signal)
  await assert.rejects(port.setMicrophone(true, signal), /media_failed/)
  assert.equal(originalStops, 0); assert.equal(original.enabled, true); assert.equal(cloneStops, 1)
  assert.equal(fresh.published, 0); await port.close(); assert.equal(graph.closes, 1)
})

test('closing external Web input joins its late wrapper and disposes only the owned branch', async () => {
  const f = fake(), signal = new AbortController().signal, wrapped = deferred<unknown>(), entered = deferred<void>()
  let branchStops = 0
  const branch = { id: 'branch', kind: 'audio', readyState: 'live', enabled: true, stop() { if (this.readyState !== 'ended') branchStops++; this.readyState = 'ended' } }
  const original = { id: 'original', kind: 'audio', readyState: 'live', enabled: true, clone: () => branch,
    stop() { assert.fail('host source must survive') } } as unknown as MediaStreamTrack
  const graph = audioGraph(original, branch)
  const port = createLiveKitWebMedia(f.callbacks, { ...f.deps, ...graph.deps, externalInput: { participantId: grant.participant_id,
    memberGeneration: 1, track: original, wrapTrack: () => { entered.resolve(); return wrapped.promise } } })
  await port.connect(grant, signal)
  const capture = port.setMicrophone(true, signal)
  await entered.promise
  let done = false; const closing = port.close().then(() => { done = true })
  await Promise.resolve(); await Promise.resolve(); assert.equal(done, false)
  wrapped.resolve({ mediaStreamTrack: branch, stop: () => branch.stop() })
  await capture; await closing
  assert.equal(f.published, 0); assert.equal(branchStops, 1); assert.equal(original.enabled, true); assert.equal(graph.closes, 1)
})

for (const failure of ['activation', 'cleanup'] as const) {
  test(`external Web ${failure} failure preserves the host source and reports fixed errors`, async () => {
    const f = fake(), signal = new AbortController().signal
    const original = { id: 'original', kind: 'audio', readyState: 'live', enabled: true,
      stop() { assert.fail('host source must survive') } } as unknown as MediaStreamTrack
    const branch = { id: 'branch', kind: 'audio', readyState: 'live', enabled: true, stop() { this.readyState = 'ended' } }
    const graph = audioGraph(original, branch)
    if (failure === 'activation') graph.context.resume = async () => { throw Error('private activation details') }
    else graph.context.close = async () => { throw Error('private cleanup details') }
    const port = createLiveKitWebMedia(f.callbacks, { ...f.deps, ...graph.deps,
      externalInput: { participantId: grant.participant_id, memberGeneration: 1, track: original,
        wrapTrack: track => ({ mediaStreamTrack: track, stop: () => track.stop() }) } })
    await port.connect(grant, signal)
    if (failure === 'activation') {
      await assert.rejects(port.setMicrophone(true, signal), { message: 'media_failed' })
      await port.close(); assert.equal(f.published, 0); assert.equal(graph.closes, 1)
    } else {
      await port.setMicrophone(true, signal)
      await assert.rejects(port.close(), { message: 'cleanup_failed' })
    }
    assert.equal(original.enabled, true); assert.equal(branch.readyState, 'ended')
  })
}

test('source finish preserves a publication whose acknowledgement arrives after local stop', async () => {
  const f = fake(), published = deferred<{ trackSid: string }>(), entered = deferred<void>(), signal = new AbortController().signal
  f.room.localParticipant.publishTrack = async () => { entered.resolve(); return published.promise }
  const port = createLiveKitWebMedia(f.callbacks, f.deps)
  await port.connect(grant, signal)
  const capture = port.setMicrophone(true, signal)
  await entered.promise
  port.holdMicrophone!(); assert.equal(f.local.mediaStreamTrack.enabled, false)
  published.resolve({ trackSid: 'TR_original' }); await capture
  assert.equal(port.microphonePublication!(), 'TR_original'); assert.equal(f.stopped, 0)
  await port.close()
})

test('LiveKit playback admits exact processor and approved SID, including late subscription callbacks', async () => {
  const f = fake(), signal = new AbortController().signal
  const port = createLiveKitWebMedia(f.callbacks, f.deps)
  await port.connect(grant, signal)
  f.subscribe()
  assert.equal(f.attaches, 0)
  await port.setPlayback(f.admitted, signal)
  assert.equal(f.attaches, 1)
  assert.equal(f.plays, 1)
  await port.setPlayback(f.admitted, signal)
  assert.equal(f.attaches, 1, 'metadata for another unit on the same track must not restart playback')
  port.silencePlayback()
  f.subscribe()
  assert.equal(f.attaches, 1, 'late callbacks cannot bypass the synchronous silence gate')
  await port.close()
})

test('old receive tracks must unsubscribe before the clear-buffer acknowledgement', async () => {
  const f = fake(), signal = new AbortController().signal
  const port = createLiveKitWebMedia(f.callbacks, f.deps)
  await port.connect(grant, signal)
  await port.setPlayback(f.admitted, signal); f.subscribe()
  let cleared = false
  const clearing = port.clearPlayback(signal).then(() => { cleared = true })
  await Promise.resolve()
  assert.equal(cleared, false)
  assert.equal(f.publication.desired, false)
  f.unsubscribe(); await clearing
  assert.equal(cleared, true)
  await port.close()
})

test('a microphone acquired after cancellation is stopped and never published', async () => {
  const f = fake(), capture = deferred<unknown>(), abort = new AbortController()
  const port = createLiveKitWebMedia(f.callbacks, { ...f.deps, createMicrophone: () => capture.promise })
  await port.connect(grant, new AbortController().signal)
  const starting = port.setMicrophone(true, abort.signal)
  abort.abort(); port.muteMicrophone()
  capture.resolve(f.local)
  await starting
  assert.equal(f.published, 0)
  assert.equal(f.stopped, 1)
  await port.close()
})

test('connection identity mismatch closes media and exposes no vendor message', async () => {
  const f = fake()
  f.room.name = 'another-room'
  const port = createLiveKitWebMedia(f.callbacks, f.deps)
  await assert.rejects(port.connect(grant, new AbortController().signal), /media_failed/)
  assert.equal(f.published, 0)
  assert.equal(f.disconnects, 1)
})

test('rapid mute and unmute share one pending microphone acquisition with the latest owner', async () => {
  const f = fake(), capture = deferred<unknown>(), old = new AbortController()
  let acquisitions = 0
  const port = createLiveKitWebMedia(f.callbacks, { ...f.deps, createMicrophone: () => { acquisitions++; return capture.promise } })
  await port.connect(grant, new AbortController().signal)
  const first = port.setMicrophone(true, old.signal)
  old.abort(); port.muteMicrophone()
  const latest = port.setMicrophone(true, new AbortController().signal)
  assert.equal(acquisitions, 1)
  capture.resolve(f.local)
  await Promise.all([first, latest])
  assert.equal(f.published, 1)
  assert.equal(f.stopped, 0)
  await port.close()
})

test('reconnecting retires both directions instead of reusing old authority', async () => {
  const f = fake(), signal = new AbortController().signal
  const port = createLiveKitWebMedia(f.callbacks, f.deps)
  await port.connect(grant, signal); await port.setMicrophone(true, signal)
  await port.setPlayback(f.admitted, signal); f.subscribe()
  f.room.emit(RoomEvent.Reconnecting)
  assert.equal(f.local.mediaStreamTrack.enabled, false)
  assert.ok(f.events.includes('disconnected'))
  await port.close()
})
