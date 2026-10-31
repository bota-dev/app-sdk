import type { SpeechGrant, SpeechMediaCallbacks, SpeechMediaPort, SpeechTrack } from './speechHost.ts'
import { SpeechSessionError } from './speechHost.ts'

// Keep supplier declaration files out of the public SDK surface. The host supplies
// the pinned vendor's public factories; this narrow runtime boundary is checked
// before connecting. No private vendor engine or declaration patch is used.
interface LocalAudioTrack { mediaStreamTrack: { enabled: boolean }; stop(): void }
interface RemoteTrack { kind: string }
interface RemoteAudioTrack extends RemoteTrack {
  setVolume(value: number): void
  attach(element: HTMLMediaElement): unknown
  detach(element: HTMLMediaElement): unknown
}
interface RemoteTrackPublication { kind: string; trackSid: string; setSubscribed(value: boolean): void }
interface RemoteParticipant { identity: string; trackPublications: ReadonlyMap<string, RemoteTrackPublication> }
interface TextReader extends AsyncIterable<string> {
  withAbortSignal(signal: AbortSignal): TextReader
  [Symbol.asyncIterator](): AsyncIterator<string> & { return(): Promise<IteratorResult<string>> }
}
interface RoomEvents {
  trackPublished: (publication: RemoteTrackPublication, participant: RemoteParticipant) => void
  trackSubscribed: (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => void
  trackUnsubscribed: (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => void
  trackUnpublished: (publication: RemoteTrackPublication, participant: RemoteParticipant) => void
  disconnected: () => void; reconnecting: () => void; signalReconnecting: () => void
}
interface Room {
  name: string
  localParticipant: { identity: string;
    publishTrack(track: LocalAudioTrack, options: { source: string; name: string }): Promise<unknown>
    unpublishTrack(track: LocalAudioTrack, stop: boolean): Promise<unknown> }
  remoteParticipants: ReadonlyMap<string, RemoteParticipant>
  on<K extends keyof RoomEvents>(event: K, callback: RoomEvents[K]): unknown
  off<K extends keyof RoomEvents>(event: K, callback: RoomEvents[K]): unknown
  connect(url: string, token: string, options: { autoSubscribe: boolean; maxRetries: number; websocketTimeout: number }): Promise<void>
  disconnect(): Promise<void>
  startAudio(): Promise<void>
  registerTextStreamHandler(topic: string, callback: (reader: TextReader, participant: { identity: string }) => void): void
  unregisterTextStreamHandler(topic: string): void
}
const RoomEvent = { TrackPublished: 'trackPublished', TrackSubscribed: 'trackSubscribed',
  TrackUnsubscribed: 'trackUnsubscribed', TrackUnpublished: 'trackUnpublished', Disconnected: 'disconnected',
  Reconnecting: 'reconnecting', SignalReconnecting: 'signalReconnecting' } as const
const Track = { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } } as const

/** Public vendor factories only. Returned media objects never cross the Rust/JS policy boundary. */
export interface LiveKitWebDependencies {
  roomFactory(options: { reconnectPolicy: { nextRetryDelayInMs(): null }; stopLocalTrackOnUnpublish: boolean;
    disconnectOnPageLeave: boolean; adaptiveStream: boolean; dynacast: boolean }): unknown
  createMicrophone?(options: { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean }): Promise<unknown>
  /** Admit this participant as host_external on the host backend first. The SDK
   * derives audio from this track's output (including its mute state); wrap only the owned branch in
   * the vendor's public LocalAudioTrack constructor (userProvidedTrack=true). */
  externalInput?: {
    participantId: string; memberGeneration: number; track: MediaStreamTrack
    wrapTrack(ownedBranch: MediaStreamTrack): unknown | Promise<unknown>
  }
  /** Optional browser factories. Each context is fresh and owned by this adapter. */
  createAudioContext?(): AudioContext
  createMediaStream?(tracks: MediaStreamTrack[]): MediaStream
  /** Disable raw vendor logs before constructing the room. The host owns its vendor logger. */
  silenceVendorLogs(): void
  createAudioElement?(): HTMLAudioElement
}
function methods(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && names.every(name => typeof (value as Record<string, unknown>)[name] === 'function')
}

/** Optional LiveKit Cloud candidate; inject the host's qualified LiveKit runtime. */
export function createLiveKitWebMedia(callbacks: SpeechMediaCallbacks, dependencies: LiveKitWebDependencies): SpeechMediaPort {
  const external = dependencies.externalInput && { ...dependencies.externalInput }
  if (external ? !external.participantId || !Number.isSafeInteger(external.memberGeneration) || external.memberGeneration < 1 ||
    !methods(external.track, ['stop']) || !external.track.id || external.track.kind !== 'audio' || external.track.readyState !== 'live' ||
    typeof external.wrapTrack !== 'function' : typeof dependencies.createMicrophone !== 'function')
    throw new SpeechSessionError('invalid_input')
  dependencies.silenceVendorLogs()
  const rawRoom = dependencies.roomFactory({
    reconnectPolicy: { nextRetryDelayInMs: () => null },
    stopLocalTrackOnUnpublish: true, disconnectOnPageLeave: true,
    adaptiveStream: false, dynacast: false,
  })
  if (!methods(rawRoom, ['on', 'off', 'connect', 'disconnect', 'startAudio', 'registerTextStreamHandler', 'unregisterTextStreamHandler']) ||
      !methods(rawRoom.localParticipant, ['publishTrack', 'unpublishTrack']) ||
      !methods(rawRoom.remoteParticipants, ['values'])) throw new SpeechSessionError('invalid_input')
  const room = rawRoom as unknown as Room
  const acquire = async () => {
    if (!external) return dependencies.createMicrophone!({ echoCancellation: true, noiseSuppression: true, autoGainControl: true })
    if (external.track.readyState !== 'live') throw new SpeechSessionError('media_failed')
    let context: AudioContext
    try { context = dependencies.createAudioContext?.() ?? new AudioContext() } catch { throw new SpeechSessionError('media_failed') }
    let source: MediaStreamAudioSourceNode | undefined, destination: MediaStreamAudioDestinationNode | undefined
    let branch: MediaStreamTrack | undefined, retiring: Promise<void> | undefined
    const resource = { retire: () => {
      if (retiring) return retiring
      let failed = false
      try { source?.disconnect() } catch { failed = true }
      try { destination?.disconnect() } catch { failed = true }
      try { if (branch && branch !== external.track && branch.id !== external.track.id) branch.stop() } catch { failed = true }
      retiring = Promise.resolve().then(async () => {
        if (context.state !== 'closed') await context.close()
        if (failed) throw new SpeechSessionError('cleanup_failed')
      }).catch(() => { uncertainCaptureCleanup = true; throw new SpeechSessionError('cleanup_failed') })
        .finally(() => { branches.delete(resource) })
      void retiring.catch(() => {})
      return retiring
    } }
    branches.add(resource)
    try {
      const stream = dependencies.createMediaStream?.([external.track]) ?? new MediaStream([external.track])
      source = context.createMediaStreamSource(stream); destination = context.createMediaStreamDestination()
      branch = destination.stream.getAudioTracks()[0]
      if (!branch || branch === external.track || !branch.id || branch.id === external.track.id ||
        branch.kind !== 'audio' || branch.readyState !== 'live') throw new SpeechSessionError('media_failed')
      branch.enabled = false
      // A direct clone bypasses later host-track enabled=false. Derive from the
      // original track's rendered samples so host mute remains authoritative.
      source.connect(destination)
      await context.resume()
      if (closed || context.state !== 'running') throw new SpeechSessionError('media_failed')
      const local = await external.wrapTrack(branch)
      if (!methods(local, ['stop']) || local.mediaStreamTrack !== branch) throw new SpeechSessionError('media_failed')
      if (external.track.readyState !== 'live') throw new SpeechSessionError('media_failed')
      graphs.set(local as unknown as LocalAudioTrack, resource)
      return local
    } catch {
      await resource.retire()
      throw new SpeechSessionError('media_failed')
    }
  }
  const audioElement = dependencies.createAudioElement ?? (() => document.createElement('audio'))
  let closed = false, joined = false, processor = '', captureVersion = 0
  let microphone: LocalAudioTrack | undefined
  let holdingMicrophone = false, microphoneSid: string | undefined
  let acquisition: { promise: Promise<unknown>; claim: number } | undefined
  let closing: Promise<void> | undefined
  let connecting: Promise<void> | undefined, publishing: Promise<unknown> | undefined
  let attempted = false, uncertainCaptureCleanup = false
  const stopped = new WeakSet<object>()
  const branches = new Set<{ retire(): Promise<void> }>()
  const graphs = new WeakMap<LocalAudioTrack, { retire(): Promise<void> }>()
  const allowed = new Set<string>()
  const received = new Map<string, { track: RemoteAudioTrack; publication: RemoteTrackPublication }>()
  const attached = new Map<string, { track: RemoteAudioTrack; element: HTMLAudioElement }>()
  const clears = new Set<() => void>()
  const readers = new Set<AbortController>()
  const handlers: Array<() => void> = []

  function check(signal: AbortSignal) { if (closed || signal.aborted) throw new SpeechSessionError('closed') }
  function stopTrack(track: LocalAudioTrack) {
    if (stopped.has(track)) return graphs.get(track)?.retire()
    stopped.add(track)
    try { track.stop() } catch { uncertainCaptureCleanup = true; throw new SpeechSessionError('cleanup_failed') }
    finally { void graphs.get(track)?.retire() }
    return graphs.get(track)?.retire()
  }
  function detach(sid: string) {
    const output = attached.get(sid)
    if (!output) return
    attached.delete(sid)
    output.element.muted = true; output.element.pause()
    output.track.setVolume(0)
    output.track.detach(output.element)
    output.element.srcObject = null; output.element.remove()
  }
  function muteMicrophone() {
    captureVersion++
    if (microphone) microphone.mediaStreamTrack.enabled = false
  }
  function silencePlayback() {
    allowed.clear()
    for (const sid of [...attached.keys()]) detach(sid)
    for (const { track, publication } of received.values()) {
      track.setVolume(0); publication.setSubscribed(false)
    }
  }
  function notifyClear() { for (const waiter of [...clears]) waiter() }
  function lost() {
    if (closed) return
    silencePlayback(); muteMicrophone()
    callbacks.disconnected()
    void close().catch(() => callbacks.failed())
  }
  function bind(sid: string) {
    if (closed || !joined || !allowed.has(sid) || attached.has(sid)) return
    const receivedTrack = received.get(sid)
    if (!receivedTrack) return
    const element = audioElement(), track = receivedTrack.track
    element.muted = true; element.autoplay = false
    track.setVolume(0); track.attach(element)
    attached.set(sid, { track, element })
    // No await between the admission check and attaching/unmuting this renderer.
    element.muted = false; track.setVolume(1)
    void element.play().catch(() => { if (!closed && attached.get(sid)?.element === element) callbacks.playbackBlocked() })
  }
  const published = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    const eligible = !closed && participant.identity === processor && publication.kind === Track.Kind.Audio && allowed.has(publication.trackSid)
    publication.setSubscribed(eligible)
  }
  const subscribed = (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (track.kind !== Track.Kind.Audio) { publication.setSubscribed(false); return }
    const audio = track as RemoteAudioTrack
    audio.setVolume(0)
    if (closed || participant.identity !== processor) { publication.setSubscribed(false); return }
    if (!received.has(publication.trackSid) && received.size >= 16) { callbacks.failed(); return }
    received.set(publication.trackSid, { track: audio, publication })
    if (!allowed.has(publication.trackSid)) publication.setSubscribed(false)
    else bind(publication.trackSid)
  }
  const unsubscribed = (track: RemoteTrack, publication: RemoteTrackPublication) => {
    if (received.get(publication.trackSid)?.track !== track) return
    detach(publication.trackSid); received.delete(publication.trackSid); notifyClear()
  }
  const unpublished = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (participant.identity !== processor) return
    detach(publication.trackSid); received.delete(publication.trackSid); allowed.delete(publication.trackSid)
    notifyClear()
    if (!closed) callbacks.trackRemoved(publication.trackSid)
  }
  room.on(RoomEvent.TrackPublished, published)
  room.on(RoomEvent.TrackSubscribed, subscribed)
  room.on(RoomEvent.TrackUnsubscribed, unsubscribed)
  room.on(RoomEvent.TrackUnpublished, unpublished)
  room.on(RoomEvent.Disconnected, lost)
  room.on(RoomEvent.Reconnecting, lost)
  room.on(RoomEvent.SignalReconnecting, lost)
  handlers.push(() => {
    room.off(RoomEvent.TrackPublished, published); room.off(RoomEvent.TrackSubscribed, subscribed)
    room.off(RoomEvent.TrackUnsubscribed, unsubscribed); room.off(RoomEvent.TrackUnpublished, unpublished)
    room.off(RoomEvent.Disconnected, lost); room.off(RoomEvent.Reconnecting, lost); room.off(RoomEvent.SignalReconnecting, lost)
  })
  room.registerTextStreamHandler('bota.speech.v1', (reader, participant) => {
    const abort = new AbortController()
    if (closed || participant.identity !== processor || readers.size >= 8) {
      abort.abort()
      void reader.withAbortSignal(abort.signal)[Symbol.asyncIterator]().return().catch(() => {})
      if (!closed && participant.identity === processor && readers.size >= 8) callbacks.failed()
      return
    }
    readers.add(abort)
    const timeout = setTimeout(() => abort.abort(), 5_000)
    void (async () => {
      let text = '', bytes = 0
      for await (const chunk of reader.withAbortSignal(abort.signal)) {
        bytes += new TextEncoder().encode(chunk).length
        if (bytes > 32 * 1024) throw new SpeechSessionError('media_failed')
        text += chunk
      }
      if (!closed && !abort.signal.aborted) callbacks.text(participant.identity, text)
      else if (!closed) callbacks.failed()
    })().catch(() => { if (!closed) callbacks.failed() }).finally(() => {
      clearTimeout(timeout); abort.abort(); readers.delete(abort)
    })
  })

  function close(): Promise<void> {
    if (closing) return closing
    closed = true; joined = false
    // Retire handlers before asynchronous teardown or queued vendor callbacks.
    let failed = false
    const attempt = (work: () => void) => { try { work() } catch { failed = true } }
    for (const remove of handlers) attempt(remove)
    attempt(() => room.unregisterTextStreamHandler('bota.speech.v1'))
    for (const reader of readers) reader.abort()
    attempt(silencePlayback); attempt(muteMicrophone)
    attempt(() => { if (microphone) stopTrack(microphone) }); microphone = undefined
    const retiring = [...branches].map(branch => branch.retire())
    notifyClear()
    closing = Promise.resolve().then(async () => {
      const pendingConnection = connecting
      try { await room.disconnect() } catch { failed = true }
      await Promise.allSettled([pendingConnection, acquisition?.promise, publishing, ...retiring])
      await Promise.allSettled([...branches].map(branch => branch.retire()))
      if (pendingConnection) { try { await room.disconnect() } catch { failed = true } }
      received.clear()
      if (failed || uncertainCaptureCleanup) throw new SpeechSessionError('cleanup_failed')
    })
    return closing
  }
  return {
    async connect(grant: SpeechGrant, signal) {
      check(signal)
      if (attempted || external && (external.participantId !== grant.participant_id || external.memberGeneration !== grant.member_generation))
        throw new SpeechSessionError('invalid_input')
      attempted = true; processor = grant.processor_identity
      const abort = () => { void close().catch(() => callbacks.failed()) }
      signal.addEventListener('abort', abort, { once: true })
      try {
        connecting = room.connect(grant.url, grant.token, { autoSubscribe: false, maxRetries: 0, websocketTimeout: 8_000 })
        try { await connecting } finally { connecting = undefined }
        check(signal)
        if (room.name !== grant.room || room.localParticipant.identity !== grant.identity) throw new SpeechSessionError('media_failed')
        joined = true
        for (const participant of room.remoteParticipants.values()) {
          for (const publication of participant.trackPublications.values()) published(publication, participant)
        }
      } catch {
        await close()
        throw new SpeechSessionError('media_failed')
      } finally { signal.removeEventListener('abort', abort) }
    },
    silencePlayback, muteMicrophone,
    holdMicrophone() {
      if (closed) throw new SpeechSessionError('closed')
      holdingMicrophone = true
      if (microphone) microphone.mediaStreamTrack.enabled = false
    },
    microphonePublication() {
      if (closed) throw new SpeechSessionError('closed')
      if (!microphone) return null
      if (!microphoneSid) throw new SpeechSessionError('media_failed')
      return microphoneSid
    },
    async clearPlayback(signal) {
      check(signal); silencePlayback()
      if (!received.size) return
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clears.delete(test); signal.removeEventListener('abort', cancel); reject(new SpeechSessionError('closed')) }
        const test = () => {
          if (closed || signal.aborted) { cancel(); return }
          if (!received.size) { clears.delete(test); signal.removeEventListener('abort', cancel); resolve() }
        }
        clears.add(test); signal.addEventListener('abort', cancel, { once: true }); test()
      })
    },
    async setPlayback(tracks: readonly SpeechTrack[], signal) {
      check(signal)
      allowed.clear(); for (const track of tracks) allowed.add(track.mediaTrackSid)
      for (const sid of [...attached.keys()]) if (!allowed.has(sid)) detach(sid)
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) published(publication, participant)
      }
      for (const sid of allowed) bind(sid)
    },
    async setMicrophone(enabled, signal) {
      check(signal)
      if (!enabled) {
        muteMicrophone()
        holdingMicrophone = false; microphoneSid = undefined
        const old = microphone; microphone = undefined
        if (old) { const retired = stopTrack(old); await room.localParticipant.unpublishTrack(old, true); await retired }
        return
      }
      if (!joined) throw new SpeechSessionError('media_failed')
      if (microphone) { microphone.mediaStreamTrack.enabled = !holdingMicrophone; return }
      const version = captureVersion
      const pending = acquisition ?? { promise: acquire(), claim: version }
      acquisition = pending; pending.claim = version
      let acquired: unknown
      try { acquired = await pending.promise }
      finally { if (acquisition === pending) acquisition = undefined }
      if (!methods(acquired, ['stop']) || typeof acquired.mediaStreamTrack !== 'object' || acquired.mediaStreamTrack === null ||
          typeof (acquired.mediaStreamTrack as { enabled?: unknown }).enabled !== 'boolean') throw new SpeechSessionError('media_failed')
      const local = acquired as unknown as LocalAudioTrack
      if (closed || signal.aborted || version !== captureVersion) {
        if (closed || pending.claim === version) await stopTrack(local)
        return
      }
      microphone = local
      local.mediaStreamTrack.enabled = !holdingMicrophone
      try {
        publishing = room.localParticipant.publishTrack(local, { source: Track.Source.Microphone, name: 'bota-original' })
        let publication: unknown
        try { publication = await publishing } finally { publishing = undefined }
        if (closed || signal.aborted || version !== captureVersion) {
          local.mediaStreamTrack.enabled = false; stopTrack(local)
          await room.localParticipant.unpublishTrack(local, true)
          if (microphone === local) microphone = undefined
        } else microphoneSid = typeof publication === 'object' && publication !== null &&
          typeof (publication as { trackSid?: unknown }).trackSid === 'string' ? (publication as { trackSid: string }).trackSid : undefined
      } catch { stopTrack(local); if (microphone === local) microphone = undefined; throw new SpeechSessionError('media_failed') }
    },
    async resumeAudio() { if (closed) throw new SpeechSessionError('closed'); await room.startAudio() },
    close,
  }
}
