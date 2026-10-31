// Generated from frameworks/shared/speechHost.ts. Do not edit.
/** Shared IO orchestration. Authorization and protocol decisions belong to Rust. */
export interface SpeechConfiguration {
  context: { projectId: string; sessionId: string; participantId: string; memberGeneration: number;
    retention: 'original_audio_and_text' | 'text_only' | 'live_only'; canPublish: boolean; canSubscribe: boolean }
  subscription: SpeechSubscription
}
export interface SpeechSubscription {
  revision: number
  targetLanguage: string
  mode: 'translated' | 'original' | 'captions_only'
  sourceParticipantIds: string[]
}
export type SpeechSelection = Omit<SpeechSubscription, 'revision'>
export interface SpeechGrant {
  protocol_version: number; provider: string; url: string; room: string; identity: string; token: string
  expires_at: string; session_id: string; participant_id: string; member_generation: number
  worker_generation: number; processor_identity: string
}
export interface SpeechTrack {
  mediaTrackSid: string; sourceId: string; sourceEpoch: number; sourceParticipantId: string
  origin: string; outputId: string | null
}
export interface SpeechUpdate {
  connected: boolean; disconnect: boolean; canCapture: boolean; canPlay: boolean
  subscriptionRevision: number; changeId: number; clearGeneration: number; clearPlayback: boolean
  expiresAtMs: number; gap: boolean; event: Record<string, unknown> | null; tracks: SpeechTrack[]
  recovery: SpeechCaptionRecovery; captions: SpeechCaptionUpdate[]
}
export interface SpeechCaptionRequest {
  requestId: number; projectId: string; sessionId: string; participantId: string
  memberGeneration: number; subscriptionRevision: number; limit: number; cursor: string | null
}
export interface SpeechCaptionRecovery {
  status: 'disabled' | 'waiting' | 'reading' | 'ready' | 'unavailable' | 'retrying' | 'stale' | 'closed'
  cursor: string | null; hasMore: boolean; request: SpeechCaptionRequest | null
}
/** Apply by key; confirmed text must never be replaced by a late interim update. */
export interface SpeechCaptionUpdate {
  key: string; origin: 'live' | 'recovered'; final: boolean; subscriptionRevision: number
  sequence: string | null; record: Readonly<Record<string, unknown>>
}
/** The host maps its authenticated HTTP outcome without exposing raw errors. */
export class SpeechCaptionReadError extends Error {
  readonly code: 'unauthorized' | 'stale_subscription' | 'unavailable'
  constructor(code: SpeechCaptionReadError['code']) { super(code); this.name = 'SpeechCaptionReadError'; this.code = code }
}
export interface SpeechPolicy {
  step(commandJson: string, nowMs: number): SpeechUpdate
  dispose(): void
}
export interface SpeechMediaCallbacks {
  text(sender: string, json: string): void
  trackRemoved(mediaTrackSid: string): void
  disconnected(): void
  failed(): void
  playbackBlocked(): void
}
/** A port must fence late asynchronous effects after abort, silence, mute and close. */
export interface SpeechMediaPort {
  connect(grant: SpeechGrant, signal: AbortSignal): Promise<void>
  /** Synchronous: prevent any already attached audio from becoming audible. */
  silencePlayback(): void
  /** Synchronous: disable already acquired capture; cancel pending capture on signal. */
  muteMicrophone(): void
  /** Resolve only when old native playback buffers have been discarded. */
  clearPlayback(signal: AbortSignal): Promise<void>
  setPlayback(tracks: readonly SpeechTrack[], signal: AbortSignal): Promise<void>
  setMicrophone(enabled: boolean, signal: AbortSignal): Promise<void>
  resumeAudio?(): Promise<void>
  /** Terminal and idempotent; retire callbacks before awaiting vendor teardown. */
  close(): Promise<void>
}
export interface SpeechHostCallbacks {
  changeSubscription(selection: SpeechSelection, signal: AbortSignal): Promise<SpeechSubscription>
  renewGrant(signal: AbortSignal): Promise<SpeechGrant>
  /** Optional retained-caption recovery through the customer's authenticated proxy.
   * Return the response body unchanged; shared Rust validates its complete scope. */
  readCaptions?(request: Readonly<SpeechCaptionRequest>, signal: AbortSignal): Promise<unknown>
}
export interface SpeechClock {
  now(): number
  every(milliseconds: number, callback: () => void): () => void
}
export type SpeechErrorCode = 'invalid_input' | 'closed' | 'superseded' | 'media_failed' |
  'media_timeout' | 'subscription_unavailable' | 'authorization_unavailable' | 'playback_blocked' | 'cleanup_failed' |
  'caption_recovery_unavailable' | 'caption_recovery_stale'
export class SpeechSessionError extends Error {
  readonly code: SpeechErrorCode
  constructor(code: SpeechErrorCode) { super(code); this.name = 'SpeechSessionError'; this.code = code }
}
export interface SpeechSessionOptions {
  configuration: SpeechConfiguration
  grant: SpeechGrant
  policyFactory(configurationJson: string, grantJson: string, nowMs: number): SpeechPolicy
  mediaFactory(callbacks: SpeechMediaCallbacks): SpeechMediaPort
  host: SpeechHostCallbacks
  signal?: AbortSignal
  clock?: SpeechClock
  onState?(state: SpeechUpdate): void
  onEvent?(event: Readonly<Record<string, unknown>>): void
  /** Live/interim and recovered/final text share stable upsert keys. No audio effects. */
  onCaption?(caption: Readonly<SpeechCaptionUpdate>): void
  onError?(error: SpeechSessionError): void
}
export interface SpeechSession {
  readonly ready: Promise<void>
  readonly state: SpeechUpdate
  setMicrophone(enabled: boolean): Promise<void>
  setListening(enabled: boolean): Promise<void>
  changeSubscription(selection: SpeechSelection): Promise<void>
  resumeAudio(): Promise<void>
  /** Join one recovery page. Automatic bounded polling continues while connected. */
  recoverCaptions(): Promise<SpeechCaptionRecovery>
  close(): Promise<void>
}
function defaultClock(): SpeechClock {
  const performanceClock = (globalThis as { performance?: { now(): number } }).performance
  const epoch = Date.now(), monotonic = performanceClock?.now()
  return {
    now: () => Math.floor(Math.max(Date.now(), monotonic === undefined ? epoch : epoch + performanceClock!.now() - monotonic)),
    every(ms, callback) { const timer = setInterval(callback, ms); return () => clearInterval(timer) },
  }
}
function safely(callback: (() => void) | undefined) { try { callback?.() } catch { /* Observer failures cannot control media. */ } }
function bounded<T>(task: () => Promise<T>, signal: AbortSignal, abortCode: SpeechErrorCode,
  timeoutCode: SpeechErrorCode, ms = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new SpeechSessionError(abortCode)); return }
    let done = false
    const finish = (value: T | undefined, error?: unknown) => {
      if (done) return
      done = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (error !== undefined) reject(error); else resolve(value as T)
    }
    const abort = () => finish(undefined, new SpeechSessionError(abortCode))
    const timer = setTimeout(() => finish(undefined, new SpeechSessionError(timeoutCode)), ms)
    signal.addEventListener('abort', abort, { once: true })
    try { task().then(value => finish(value), error => finish(undefined, error)) }
    catch (error) { finish(undefined, error) }
  })
}

export function createSpeechSession(options: SpeechSessionOptions): SpeechSession {
  const clock = options.clock ?? defaultClock()
  const grant = JSON.parse(JSON.stringify(options.grant)) as SpeechGrant
  let policy: SpeechPolicy
  try { policy = options.policyFactory(JSON.stringify(options.configuration), JSON.stringify(grant), clock.now()) }
  catch { throw new SpeechSessionError('invalid_input') }
  let latest = policy.step(JSON.stringify({ type: 'tick' }), clock.now())
  if (options.host.readCaptions) latest = policy.step(JSON.stringify({ type: 'enable_caption_recovery' }), clock.now())
  let ended = false, connected = false
  let port: SpeechMediaPort
  const lifetime = new AbortController()
  let cancelTimer = () => {}
  let closePromise: Promise<void> | undefined
  let captureTask: Promise<void> | undefined, playbackTask: Promise<void> | undefined
  let captureAbort = new AbortController(), playbackAbort = new AbortController()
  let captureKey: boolean | undefined, playbackKey = ''
  let captureDirty = false, playbackDirty = false
  let changing: AbortController | undefined, renewing: AbortController | undefined
  let recoveryTask: Promise<void> | undefined, recoveryAbort: AbortController | undefined, recoveryId: number | undefined
  let lastRenewal = 0

  const report = (code: SpeechErrorCode) => safely(() => options.onError?.(new SpeechSessionError(code)))
  const recoverySnapshot = (): SpeechCaptionRecovery => ({ ...latest.recovery,
    request: latest.recovery.request ? { ...latest.recovery.request } : null })
  const snapshot = (): SpeechUpdate => ({ ...latest, event: null, captions: [], recovery: recoverySnapshot(),
    tracks: latest.tracks.map(track => ({ ...track })) })
  function active() { if (ended) throw new SpeechSessionError('closed') }
  function fail(code: SpeechErrorCode) {
    report(code)
    void close().catch(() => { /* close reports its own bounded cleanup failure. */ })
  }
  function command(value: Record<string, unknown>): SpeechUpdate {
    active()
    let result: SpeechUpdate
    try { result = policy.step(JSON.stringify(value), clock.now()) }
    catch { fail('invalid_input'); throw new SpeechSessionError('invalid_input') }
    const event = result.event
    const captions = result.captions
    latest = { ...result, event: null, captions: [] }
    if (result.disconnect) { void close().catch(() => {}); return result }
    reconcile()
    reconcileRecovery()
    safely(() => options.onState?.(snapshot()))
    const current = () => !ended && latest.changeId === result.changeId && latest.subscriptionRevision === result.subscriptionRevision
    for (const caption of captions) { if (!current()) break; safely(() => options.onCaption?.(caption)) }
    if (current() && event) safely(() => options.onEvent?.(event))
    return result
  }
  function receive(value: Record<string, unknown>) {
    if (ended) return
    try { command(value) } catch { /* command retires the owner before returning an error. */ }
  }
  try {
    port = options.mediaFactory({
      text: (sender, json) => receive({ type: 'event', sender, json }),
      trackRemoved: mediaTrackSid => receive({ type: 'track_removed', mediaTrackSid }),
      disconnected: () => { if (!ended) fail('media_failed') },
      failed: () => { if (!ended) fail('media_failed') },
      playbackBlocked: () => { if (!ended) report('playback_blocked') },
    })
  } catch { policy.dispose(); throw new SpeechSessionError('media_failed') }

  function reconcile() {
    if (ended || !connected) return
    if (captureKey !== latest.canCapture) {
      captureKey = latest.canCapture; captureDirty = true
      captureAbort.abort(); captureAbort = new AbortController()
      if (!latest.canCapture) {
        try { port.muteMicrophone() } catch { fail('media_failed'); return }
      }
      startCapture()
    }
    const key = JSON.stringify([latest.canPlay, latest.clearGeneration, latest.clearPlayback,
      latest.tracks.map(track => track.mediaTrackSid).sort()])
    if (key !== playbackKey) {
      playbackKey = key; playbackDirty = true
      playbackAbort.abort(); playbackAbort = new AbortController()
      if (!latest.canPlay || latest.clearPlayback) {
        try { port.silencePlayback() } catch { fail('media_failed'); return }
      }
      startPlayback()
    }
  }
  function startCapture() {
    if (captureTask || ended) return
    captureTask = (async () => {
      while (captureDirty && !ended) {
        captureDirty = false
        const signal = captureAbort.signal, enabled = latest.canCapture
        try { await bounded(() => port.setMicrophone(enabled, signal), signal, 'superseded', 'media_timeout') }
        catch (error) {
          if (signal.aborted) continue
          const code = error instanceof SpeechSessionError ? error.code : 'media_failed'
          fail(code); throw new SpeechSessionError(code)
        }
      }
    })().finally(() => { captureTask = undefined; if (captureDirty && !ended) startCapture() })
    void captureTask.catch(() => {})
  }
  function reconcileRecovery() {
    const request = latest.recovery.request
    if (ended || !connected || !options.host.readCaptions || !request || request.requestId !== recoveryId) recoveryAbort?.abort()
    if (ended || !connected || !options.host.readCaptions || !request || recoveryTask) return
    const pending = new AbortController(); recoveryAbort = pending; recoveryId = request.requestId
    // Defer the host call until task ownership exists, including synchronous callbacks.
    recoveryTask = Promise.resolve().then(async () => {
      try {
        const page = await bounded(() => options.host.readCaptions!({ ...request }, pending.signal), pending.signal,
          'superseded', 'caption_recovery_unavailable', 5_000)
        if (!ended && !pending.signal.aborted) command({ type: 'caption_page', requestId: request.requestId, page })
      } catch (error) {
        if (ended || pending.signal.aborted) return
        const reason = error instanceof SpeechCaptionReadError ? error.code : 'unavailable'
        command({ type: 'caption_failure', requestId: request.requestId, reason })
        report(reason === 'unauthorized' ? 'authorization_unavailable' : reason === 'stale_subscription' ? 'caption_recovery_stale' : 'caption_recovery_unavailable')
      }
    }).finally(() => {
      pending.abort(); recoveryTask = undefined
      if (recoveryAbort === pending) { recoveryAbort = undefined; recoveryId = undefined }
      if (!ended) reconcileRecovery()
    })
    void recoveryTask.catch(() => {})
  }
  function startPlayback() {
    if (playbackTask || ended) return
    playbackTask = (async () => {
      while (playbackDirty && !ended) {
        playbackDirty = false
        const signal = playbackAbort.signal, current = latest
        try {
          if (current.clearPlayback) {
            await bounded(() => port.clearPlayback(signal), signal, 'superseded', 'media_timeout')
            if (!ended && !signal.aborted) command({ type: 'buffers_cleared', generation: current.clearGeneration })
          } else {
            await bounded(() => port.setPlayback(current.canPlay ? current.tracks : [], signal), signal, 'superseded', 'media_timeout')
          }
        } catch (error) {
          if (signal.aborted) continue
          const code = error instanceof SpeechSessionError ? error.code : 'media_failed'
          fail(code); throw new SpeechSessionError(code)
        }
      }
    })().finally(() => { playbackTask = undefined; if (playbackDirty && !ended) startPlayback() })
    void playbackTask.catch(() => {})
  }
  async function waitCapture() { while (captureTask) await captureTask }
  async function waitPlayback() { while (playbackTask) await playbackTask }
  function tick() {
    if (ended) return
    try {
      command({ type: 'tick' })
      const now = clock.now()
      if (ended || renewing || latest.expiresAtMs - now > 30_000 || now - lastRenewal < 5_000) return
      lastRenewal = now
      const pending = new AbortController(); renewing = pending
      void bounded(() => options.host.renewGrant(pending.signal), pending.signal, 'closed', 'authorization_unavailable', 5_000)
        .then(fresh => { if (!ended && !pending.signal.aborted) command({ type: 'renew', grantJson: JSON.stringify(fresh) }) })
        .catch(() => { if (!ended) report('authorization_unavailable') })
        .finally(() => { pending.abort(); if (renewing === pending) renewing = undefined })
    } catch { /* Invalid/expired authority has already stopped this owner. */ }
  }
  function close(): Promise<void> {
    if (closePromise) return closePromise
    ended = true; connected = false
    cancelTimer(); options.signal?.removeEventListener('abort', externalAbort)
    lifetime.abort(); captureAbort.abort(); playbackAbort.abort(); changing?.abort(); renewing?.abort(); recoveryAbort?.abort()
    let cleanupFailed = false
    try { port.silencePlayback() } catch { cleanupFailed = true }
    try { port.muteMicrophone() } catch { cleanupFailed = true }
    try { latest = policy.step(JSON.stringify({ type: 'closed' }), clock.now()) } catch { /* Terminal core. */ }
    latest = { ...latest, connected: false, disconnect: true, canCapture: false, canPlay: false, event: null, captions: [], tracks: [] }
    try { policy.dispose() } catch { cleanupFailed = true }
    // Publish the promise before executing a port that can synchronously callback.
    closePromise = Promise.resolve().then(async () => {
      await Promise.allSettled([recoveryTask])
      try { await bounded(() => port.close(), new AbortController().signal, 'closed', 'cleanup_failed') }
      catch { cleanupFailed = true }
      if (cleanupFailed) { report('cleanup_failed'); throw new SpeechSessionError('cleanup_failed') }
    })
    safely(() => options.onState?.(snapshot()))
    return closePromise
  }
  const externalAbort = () => { void close().catch(() => {}) }
  options.signal?.addEventListener('abort', externalAbort, { once: true })
  const ready = (async () => {
    try {
      if (options.signal?.aborted) { await close(); throw new SpeechSessionError('closed') }
      await bounded(() => port.connect(grant, lifetime.signal), lifetime.signal, 'closed', 'media_timeout')
      active(); connected = true
      command({ type: 'connected' })
      await Promise.all([waitCapture(), waitPlayback()])
      active(); cancelTimer = clock.every(250, tick)
    } catch (error) {
      const code = ended ? 'closed' : error instanceof SpeechSessionError ? error.code : 'media_failed'
      if (!ended) fail(code)
      throw new SpeechSessionError(code)
    } finally { grant.token = '' }
  })()
  // The caller still observes a rejected ready promise; this also bounds fire-and-forget teardown.
  void ready.catch(() => {})
  return {
    ready,
    get state() { return snapshot() },
    async setMicrophone(enabled) { active(); command({ type: 'set_microphone', enabled }); await waitCapture() },
    async setListening(enabled) { active(); command({ type: 'set_listening', enabled }); await waitPlayback() },
    async changeSubscription(selection) {
      active()
      changing?.abort()
      const pending = new AbortController(); changing = pending
      const changeId = command({ type: 'begin_change' }).changeId
      try {
        const subscription = await bounded(() => options.host.changeSubscription(selection, pending.signal), pending.signal,
          'superseded', 'subscription_unavailable')
        active()
        command({ type: 'apply_desired', changeId, subscription })
      } catch (error) {
        if (ended) throw new SpeechSessionError('closed')
        if (pending.signal.aborted) throw new SpeechSessionError('superseded')
        report('subscription_unavailable')
        throw new SpeechSessionError('subscription_unavailable')
      } finally { pending.abort(); if (changing === pending) changing = undefined }
    },
    async resumeAudio() {
      active()
      try { await bounded(() => port.resumeAudio?.() ?? Promise.resolve(), lifetime.signal, 'closed', 'media_timeout') }
      catch { report('playback_blocked'); throw new SpeechSessionError('playback_blocked') }
    },
    async recoverCaptions() {
      active()
      if (!options.host.readCaptions) throw new SpeechSessionError('caption_recovery_unavailable')
      const changeId = latest.changeId
      await ready; active()
      if (latest.changeId !== changeId) throw new SpeechSessionError('superseded')
      command({ type: 'recover_captions' })
      while (recoveryTask) {
        active()
        if (latest.changeId !== changeId) throw new SpeechSessionError('superseded')
        await recoveryTask
      }
      active()
      if (latest.changeId !== changeId) throw new SpeechSessionError('superseded')
      if (latest.recovery.status === 'retrying') throw new SpeechSessionError('caption_recovery_unavailable')
      if (latest.recovery.status === 'stale') throw new SpeechSessionError('caption_recovery_stale')
      return recoverySnapshot()
    },
    close,
  }
}
