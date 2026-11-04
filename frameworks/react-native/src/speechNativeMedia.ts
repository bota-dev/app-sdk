import { SpeechSessionError, type SpeechGrant, type SpeechMediaCallbacks, type SpeechMediaPort } from './speechHost'
import { Buffer } from 'buffer'

/** Foreground native IO only. Shared speech-session policy still executes in JS.
 * The host installs public native media/capture owners; PCM and archive keys never
 * cross this interface. Synchronous fences must retire late native acquisitions.
 * closeMedia joins RTC IO only; the App separately closes its original owner. */
export interface NativeSpeechMediaIO {
  createMedia(sessionId: string): Promise<string>
  mediaCommand(handle: string, action: string, body: string): Promise<string>
  mediaFence(handle: string, action: string): boolean
  mediaEvents(handle: string): Promise<string>
  closeMedia(handle: string): Promise<void>
}
export interface NativeSpeechOriginalView {
  enabled: boolean; capturing: boolean; finished: boolean; rtcAvailable: boolean
  status: string; passages: readonly string[]
}

/** Adapt an App's native IO bridge without importing a vendor or native runtime. */
export function createNativeSpeechMedia(callbacks: SpeechMediaCallbacks, io: NativeSpeechMediaIO): SpeechMediaPort {
  if (!io || ['createMedia', 'mediaCommand', 'mediaFence', 'mediaEvents', 'closeMedia'].some(
    key => typeof io[key as keyof NativeSpeechMediaIO] !== 'function')) throw new SpeechSessionError('invalid_input')
  let handle: string | undefined, acquisition: Promise<void> | undefined, closing: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined, polling: Promise<void> | undefined
  let closed = false, failed = false, publication: string | null = null
  const operations = new Set<Promise<unknown>>()
  const check = (signal?: AbortSignal) => { if (closed || signal?.aborted) throw new SpeechSessionError('closed') }
  const fence = (action: string) => {
    if (closed || !handle) return
    if (io.mediaFence(handle, action) !== true) throw new SpeechSessionError('cleanup_failed')
  }
  const fail = () => {
    if (closed || failed) return
    failed = true
    // Retire IO before notifying App code: callbacks may throw or reenter close.
    void close().catch(() => {})
    try { callbacks.failed() } catch { /* Native cleanup remains joined. */ }
  }
  const poll = () => {
    if (closed || !handle) return
    polling = (async () => {
      const text = await io.mediaEvents(handle!)
      if (closed) return
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 524288) throw new SpeechSessionError('media_failed')
      const events: unknown = JSON.parse(text)
      if (!Array.isArray(events) || events.length > 32) throw new SpeechSessionError('media_failed')
      for (const event of events) {
        if (closed) return
        if (!event || typeof event !== 'object') throw new SpeechSessionError('media_failed')
        switch (event.type) {
          case 'text':
            if (typeof event.sender !== 'string' || event.sender.length > 256 || typeof event.json !== 'string' ||
              Buffer.byteLength(event.json, 'utf8') > 65536) throw new SpeechSessionError('media_failed')
            callbacks.text(event.sender, event.json); break
          case 'removed':
            if (typeof event.sid !== 'string' || event.sid.length > 256) throw new SpeechSessionError('media_failed')
            callbacks.trackRemoved(event.sid); break
          case 'disconnected': callbacks.disconnected(); break
          case 'failed': fail(); break
          case 'blocked': callbacks.playbackBlocked(); break
          default: throw new SpeechSessionError('media_failed')
        }
      }
    })().catch(() => fail()).finally(() => {
      polling = undefined
      if (!closed) timer = setTimeout(poll, 25)
    })
  }
  async function command(action: string, body: unknown, signal: AbortSignal) {
    check(signal)
    if (!handle) throw new SpeechSessionError('media_failed')
    const abort = () => { try { fence('silence'); fence('mute') } catch { fail() } }
    signal.addEventListener('abort', abort, { once: true })
    const task = io.mediaCommand(handle, action, JSON.stringify(body)); operations.add(task)
    try { const value = await task; check(signal); return value }
    finally { operations.delete(task); signal.removeEventListener('abort', abort) }
  }
  function close(): Promise<void> {
    if (closing) return closing
    let fenceError = false
    for (const action of ['silence', 'mute']) {
      try { fence(action) } catch { fenceError = true }
    }
    closed = true; clearTimeout(timer)
    closing = (async () => {
      await acquisition
      // Native close cancels and joins submitted operations before returning.
      if (handle) await io.closeMedia(handle)
      await Promise.allSettled([...operations, ...(polling ? [polling] : [])])
      if (fenceError) throw new SpeechSessionError('cleanup_failed')
    })()
    return closing
  }
  return {
    async connect(grant: SpeechGrant, signal) {
      check(signal)
      if (acquisition) throw new SpeechSessionError('invalid_input')
      acquisition = (async () => {
        const value = await io.createMedia(grant.session_id)
        if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new SpeechSessionError('media_failed')
        handle = value
      })()
      await acquisition; check(signal)
      poll()
      await command('connect', grant, signal)
    },
    silencePlayback: () => fence('silence'), muteMicrophone: () => fence('mute'),
    holdMicrophone: () => fence('hold'), microphonePublication: () => publication,
    async clearPlayback(signal) { await command('clear', null, signal) },
    async setPlayback(tracks, signal) { await command('playback', tracks, signal) },
    async setMicrophone(enabled, signal) {
      const response = await command('input', enabled, signal)
      const value: unknown = JSON.parse(response)
      if (value !== null && (typeof value !== 'string' || !value || value.length > 256)) throw new SpeechSessionError('media_failed')
      publication = value as string | null
    },
    async resumeAudio() { await command('resume', null, new AbortController().signal) },
    close,
  }
}
