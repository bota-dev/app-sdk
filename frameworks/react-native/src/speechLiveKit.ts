import type { SpeechGrant, SpeechMediaCallbacks, SpeechMediaPort, SpeechTrack } from './speechHost'
import { SpeechSessionError } from './speechHost'
import { Buffer } from 'buffer'

// Keep supplier declaration files out of the public SDK surface. The host supplies
// the pinned vendor's public factories; this narrow runtime boundary is checked
// before connecting. No private vendor engine or declaration patch is used.
interface LocalAudioTrack { mediaStreamTrack: { enabled: boolean }; stop(): void }
interface RemoteTrack { kind: string }
interface RemoteAudioTrack extends RemoteTrack {
  setVolume(value: number): void
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
  registerTextStreamHandler(topic: string, callback: (reader: TextReader, participant: { identity: string }) => void): void
  unregisterTextStreamHandler(topic: string): void
}
const RoomEvent = { TrackPublished: 'trackPublished', TrackSubscribed: 'trackSubscribed',
  TrackUnsubscribed: 'trackUnsubscribed', TrackUnpublished: 'trackUnpublished', Disconnected: 'disconnected',
  Reconnecting: 'reconnecting', SignalReconnecting: 'signalReconnecting' } as const
const Track = { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } } as const

/** Public vendor factories only. Returned media objects never cross the Rust/JS policy boundary. */
export interface LiveKitNativeDependencies {
  roomFactory(options: { reconnectPolicy: { nextRetryDelayInMs(): null }; stopLocalTrackOnUnpublish: boolean;
    disconnectOnPageLeave: boolean; adaptiveStream: boolean; dynacast: boolean }): unknown
  createMicrophone(options: { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean }): Promise<unknown>
  /** Disable raw vendor logs before constructing the room. The host owns its vendor logger. */
  silenceVendorLogs(): void
  /** The host has registered LiveKit globals and reserved this runtime for Bota. */
  audioSession: unknown
  audioSessionOwnership: 'exclusive'
  /** Restore the host's known prior default only after all media has disconnected. */
  restoreRemoteTrackVolume: number
  defaultOutput: 'earpiece' | 'speaker'
}
function methods(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && names.every(name => typeof (value as Record<string, unknown>)[name] === 'function')
}

interface NativeAudioSession {
  configureAudio(config: { android: { preferredOutputList: string[]; audioTypeOptions: { manageAudioFocus: boolean; audioMode: string;
    audioFocusMode: string; audioStreamType: string; audioAttributesUsageType: string; audioAttributesContentType: string } };
    ios: { defaultOutput: 'earpiece' | 'speaker' } }): Promise<void>
  setDefaultRemoteAudioTrackVolume(volume: number): Promise<void>
  startAudioSession(): Promise<void>
  stopAudioSession(): Promise<void>
}
// AudioSession defaults are process-global. Hold ownership through failed or late
// cleanup so another adapter cannot start against unknown native state.
const audioOwners = new WeakSet<object>()

/** Optional native LiveKit Cloud candidate using the host's public vendor factories. */
export function createLiveKitNativeMedia(callbacks: SpeechMediaCallbacks, dependencies: LiveKitNativeDependencies): SpeechMediaPort {
  if (dependencies.audioSessionOwnership !== 'exclusive' ||
      !Number.isFinite(dependencies.restoreRemoteTrackVolume) || dependencies.restoreRemoteTrackVolume < 0 || dependencies.restoreRemoteTrackVolume > 1 ||
      !['earpiece', 'speaker'].includes(dependencies.defaultOutput) ||
      !methods(dependencies.audioSession, ['configureAudio', 'setDefaultRemoteAudioTrackVolume', 'startAudioSession', 'stopAudioSession'])) {
    throw new SpeechSessionError('invalid_input')
  }
  const audioSession = dependencies.audioSession as unknown as NativeAudioSession
  const restoreVolume = dependencies.restoreRemoteTrackVolume, defaultOutput = dependencies.defaultOutput
  dependencies.silenceVendorLogs()
  const rawRoom = dependencies.roomFactory({
    reconnectPolicy: { nextRetryDelayInMs: () => null },
    stopLocalTrackOnUnpublish: true, disconnectOnPageLeave: false,
    adaptiveStream: false, dynacast: false,
  })
  if (!methods(rawRoom, ['on', 'off', 'connect', 'disconnect', 'registerTextStreamHandler', 'unregisterTextStreamHandler']) ||
      !methods(rawRoom.localParticipant, ['publishTrack', 'unpublishTrack']) ||
      !methods(rawRoom.remoteParticipants, ['values'])) throw new SpeechSessionError('invalid_input')
  const room = rawRoom as unknown as Room
  const acquire = () => dependencies.createMicrophone({
    echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  })
  let closed = false, joined = false, processor = '', captureVersion = 0
  let microphone: LocalAudioTrack | undefined
  let holdingMicrophone = false, microphoneSid: string | undefined
  let acquisition: { promise: Promise<unknown>; claim: number } | undefined
  let closing: Promise<void> | undefined
  let ownsAudio = false
  let attempted = false
  let uncertainCaptureCleanup = false
  let preparing: Promise<void> | undefined, connecting: Promise<void> | undefined
  let publishing: Promise<unknown> | undefined
  const allowed = new Set<string>()
  const received = new Map<string, { track: RemoteAudioTrack; publication: RemoteTrackPublication }>()
  const clears = new Set<() => void>()
  const readers = new Set<AbortController>()
  const handlers: Array<() => void> = []

  function check(signal: AbortSignal) { if (closed || signal.aborted) throw new SpeechSessionError('closed') }
  function stopTrack(track: unknown) {
    if (!methods(track, ['stop'])) { uncertainCaptureCleanup = true; throw new SpeechSessionError('cleanup_failed') }
    try { (track as unknown as { stop(): void }).stop() }
    catch { uncertainCaptureCleanup = true; throw new SpeechSessionError('cleanup_failed') }
  }
  function detach(sid: string) { received.get(sid)?.track.setVolume(0) }
  function muteMicrophone() {
    captureVersion++
    if (microphone) microphone.mediaStreamTrack.enabled = false
  }
  function silencePlayback() {
    allowed.clear()
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
    if (closed || !joined || !allowed.has(sid)) return
    received.get(sid)?.track.setVolume(1)
  }
  const published = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    const eligible = !closed && participant.identity === processor && publication.kind === Track.Kind.Audio && allowed.has(publication.trackSid)
    publication.setSubscribed(eligible)
  }
  const subscribed = (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (track.kind !== Track.Kind.Audio) { publication.setSubscribed(false); return }
    if (!methods(track, ['setVolume'])) { publication.setSubscribed(false); callbacks.failed(); return }
    const audio = track as unknown as RemoteAudioTrack
    audio.setVolume(0)
    if (closed || participant.identity !== processor) { publication.setSubscribed(false); return }
    if (!received.has(publication.trackSid) && received.size >= 16) { callbacks.failed(); return }
    const previous = received.get(publication.trackSid)
    if (previous && previous.track !== audio) {
      previous.track.setVolume(0); publication.setSubscribed(false); callbacks.failed(); return
    }
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
        bytes += Buffer.byteLength(chunk, 'utf8')
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
    let synchronousFailure = false
    const attempt = (task: () => void) => { try { task() } catch { synchronousFailure = true } }
    // Retire handlers before asynchronous teardown or queued vendor callbacks.
    for (const remove of handlers) attempt(remove)
    attempt(() => room.unregisterTextStreamHandler('bota.speech.v1'))
    for (const reader of readers) reader.abort()
    attempt(silencePlayback); attempt(muteMicrophone)
    attempt(() => { if (microphone) stopTrack(microphone) }); microphone = undefined
    notifyClear()
    closing = Promise.resolve().then(async () => {
      let failed = synchronousFailure
      // A late native start must settle before its matching stop. Do not await
      // connect() itself: its error path joins this same close promise.
      await Promise.allSettled([preparing])
      const pendingConnection = connecting
      try { await room.disconnect() } catch { failed = true }
      await Promise.allSettled([pendingConnection, acquisition?.promise, publishing])
      failed ||= uncertainCaptureCleanup
      if (pendingConnection) {
        try { await room.disconnect() } catch { failed = true }
      }
      received.clear()
      if (ownsAudio) {
        try { await audioSession.stopAudioSession() } catch { failed = true }
        if (!failed) {
          try { await audioSession.setDefaultRemoteAudioTrackVolume(restoreVolume) }
          catch { failed = true }
        }
        if (!failed) { audioOwners.delete(audioSession); ownsAudio = false }
      }
      if (failed) throw new SpeechSessionError('cleanup_failed')
    })
    return closing
  }
  return {
    async connect(grant: SpeechGrant, signal) {
      check(signal)
      if (attempted) throw new SpeechSessionError('invalid_input')
      attempted = true; processor = grant.processor_identity
      const abort = () => { void close().catch(() => callbacks.failed()) }
      signal.addEventListener('abort', abort, { once: true })
      try {
        if (audioOwners.has(audioSession)) throw new SpeechSessionError('media_failed')
        audioOwners.add(audioSession); ownsAudio = true
        preparing = Promise.resolve().then(async () => {
          check(signal)
          await audioSession.configureAudio({ android: {
            preferredOutputList: ['bluetooth', 'headset', defaultOutput, defaultOutput === 'speaker' ? 'earpiece' : 'speaker'],
            audioTypeOptions: {
            manageAudioFocus: true, audioMode: 'inCommunication', audioFocusMode: 'gain',
            audioStreamType: 'voiceCall', audioAttributesUsageType: 'voiceCommunication', audioAttributesContentType: 'speech',
          } }, ios: { defaultOutput } })
          check(signal)
          await audioSession.setDefaultRemoteAudioTrackVolume(0)
          check(signal)
          await audioSession.startAudioSession()
        })
        await preparing
        check(signal)
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
      for (const sid of received.keys()) if (!allowed.has(sid)) detach(sid)
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
        if (old) { stopTrack(old); await room.localParticipant.unpublishTrack(old, true) }
        return
      }
      if (microphone) { microphone.mediaStreamTrack.enabled = !holdingMicrophone; return }
      const version = captureVersion
      const pending = acquisition ?? { promise: acquire(), claim: version }
      acquisition = pending; pending.claim = version
      let acquired: unknown
      try { acquired = await pending.promise }
      finally { if (acquisition === pending) acquisition = undefined }
      if (!methods(acquired, ['stop']) || typeof acquired.mediaStreamTrack !== 'object' || acquired.mediaStreamTrack === null ||
          typeof (acquired.mediaStreamTrack as { enabled?: unknown }).enabled !== 'boolean') {
        stopTrack(acquired)
        throw new SpeechSessionError('media_failed')
      }
      const local = acquired as unknown as LocalAudioTrack
      if (closed || signal.aborted || version !== captureVersion) {
        if (closed || pending.claim === version) stopTrack(local)
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
    async resumeAudio() { if (closed || !joined) throw new SpeechSessionError('closed') },
    close,
  }
}
