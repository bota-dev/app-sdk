import { createWebSpeechCapture, recoverWebSpeechCapture, listWebSpeechCaptures, listWebSpeechCaptureReceipts,
  type WebSpeechCapture } from '@bota.dev/web-app-sdk/speech/capture'
import { createWebSpeechCaptureInput } from '@bota.dev/web-app-sdk/speech/capture-input'
import type { SpeechGrant, SpeechMediaCallbacks, SpeechMediaPort } from '@bota.dev/web-app-sdk/speech'
import { HostError, speechHost, type SpeechJoin } from './speechHost'

export type OriginalMediaFactory = (callbacks: SpeechMediaCallbacks, track: MediaStreamTrack,
  member: { participantId: string; memberGeneration: number }) => SpeechMediaPort

/** This foreground lab owns its original independently from the room. Every
 * microphone run is explicit and bounded by the current host grant. */
export async function speechOriginal(initial: SpeechJoin, host: ReturnType<typeof speechHost>, signal: AbortSignal,
  update: (status: string, passages?: string[]) => void, denied: () => void) {
  const context = initial.configuration.context
  const scope = JSON.stringify([context.projectId, context.sessionId, context.participantId, context.memberGeneration])
  const archives = new Map<string, WebSpeechCapture>(), completed = new Map<string, { after: number; digest?: string; text: string[]; done: boolean }>()
  const cancellation = new AbortController(), io = AbortSignal.any([signal, cancellation.signal])
  let current: WebSpeechCapture | undefined, input: Awaited<ReturnType<typeof createWebSpeechCaptureInput>> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined, polling: Promise<void> | undefined, closed = false
  let publishedTrack: string | undefined, boundTrack: string | undefined, workerGeneration = initial.grant.worker_generation
  let expiry = Date.parse(initial.grant.expires_at), authorityTimer: ReturnType<typeof setTimeout> | undefined
  let finished = false, started = false
  let retirement: Promise<void> | undefined
  const onError = (error: unknown) => {
    if (error instanceof HostError && error.status === 403) denied()
    else update('Original retained on this browser. Upload will retry while this page is open.')
  }
  async function poll() {
    if (closed || io.aborted) return
    if (publishedTrack && boundTrack !== publishedTrack && current) {
      try { await host.bindCapture(current.snapshot.captureId, workerGeneration, publishedTrack, io); boundTrack = publishedTrack }
      catch (error) { if (!(error instanceof HostError && error.code === 'not_ready')) onError(error) }
    }
    for (const [id, archive] of archives) {
      if (io.aborted) return
      try {
        const receipt = await archive.flush(host.capture(id), io) as { state?: string; capture_complete?: boolean }
        if (receipt.state === 'published') {
          await archive.close(); archives.delete(id)
          completed.set(id, { after: 0, text: [], done: false })
          update(receipt.capture_complete ? 'Original audio verified. Waiting for aligned text.' : 'Original audio verified with capture gaps or an unknown tail. Waiting for aligned text.')
        } else if (receipt.state === 'verification_failed') update('Original verification failed. Local encrypted audio is retained.')
      } catch (error) { if (!io.aborted) onError(error) }
    }
    for (const [id, progress] of completed) {
      if (io.aborted || progress.done) continue
      try {
        const result = await host.captureTranscript(id, progress.after, progress.digest, io)
        if (result.alignment === 'no_audio') {
          progress.done = true; update('No audio was captured. There is no final transcript.', []); continue
        }
        if (result.alignment === 'unverified' || result.state === 'failed') {
          update('Original audio is verified. Aligned text is unavailable; transcription needs attention.', []); continue
        }
        if (result.alignment !== 'verified_original' || !Array.isArray(result.segments)) continue
        if (typeof result.result_sha256 !== 'string' || !Number.isSafeInteger(result.next_segment) || Number(result.next_segment) < progress.after ||
          Number(result.next_segment) === progress.after && result.has_more === true) continue
        progress.digest = result.result_sha256; progress.after = Number(result.next_segment)
        for (const segment of result.segments) {
          if (typeof segment.text !== 'string' || !Array.isArray(segment.captureIntervals)) continue
          const times = segment.captureIntervals.slice(0, 4).map((span: { clockId: string; firstSample: number; samples: number }) =>
            `${span.clockId.slice(0, 8)} · ${(span.firstSample / 48000).toFixed(2)}–${((span.firstSample + span.samples) / 48000).toFixed(2)} s`).join(', ')
          progress.text.push(`${times}${segment.crossesDiscontinuity ? ' · crosses a capture gap' : ''}\n${new TextDecoder().decode(new TextEncoder().encode(segment.text).subarray(0, 4096))}`)
        }
        progress.text = progress.text.slice(-64); progress.done = result.has_more !== true
        update(progress.done && !progress.text.length ? 'Original audio verified. No speech was recognized.' :
          `Final text aligned to verified original samples${result.capture_complete ? '.' : '; capture gaps or an unknown tail remain.'}`, progress.text)
      } catch (error) { if (!io.aborted) onError(error) }
    }
  }
  function schedule() {
    if (closed || io.aborted) return
    timer = setTimeout(() => {
      polling = poll().catch(onError).finally(() => { polling = undefined; schedule() })
    }, 2000)
  }
  const armAuthority = () => {
    if (authorityTimer) clearTimeout(authorityTimer)
    authorityTimer = setTimeout(() => {
      if (input) input.track.enabled = false
      void input?.finish().then(() => { finished = true; update('Microphone stopped because its authorization expired. Original upload can continue.') }).catch(onError)
    }, Math.max(0, Math.min(2147483647, expiry - Date.now())))
  }
  try {
    for (const pending of await listWebSpeechCaptures(scope)) {
      io.throwIfAborted()
      try { archives.set(pending.captureId, await recoverWebSpeechCapture({ scope, captureId: pending.captureId })) }
      catch { update('An existing original is busy or needs recovery. Its encrypted data is retained.') }
    }
    for (const receipt of await listWebSpeechCaptureReceipts(scope)) completed.set(receipt.captureId, { after: 0, text: [], done: false })
    const captureId = crypto.randomUUID(), prepared = await host.prepareCapture(captureId, io)
    io.throwIfAborted()
    current = await createWebSpeechCapture({ scope, prepared }); archives.set(captureId, current)
    input = await createWebSpeechCaptureInput({ archive: current, onError: code => update(code === 'archive_write_failed' ?
      'An original audio write failed. Missing samples will be marked as gaps.' : 'Capture was interrupted. An unknown tail may remain.') })
    io.throwIfAborted(); armAuthority(); schedule()
    update('Original audio will be encrypted on this browser when you start the microphone.')
  } catch (error) {
    cancellation.abort(); await input?.close()
    await Promise.allSettled([...archives.values()].map(archive => archive.close()))
    throw error
  }
  return {
    get capturing() { return input!.capturing },
    get finished() { return finished },
    renew(grant: SpeechGrant) {
      if (grant.participant_id !== context.participantId || grant.member_generation !== context.memberGeneration) { denied(); return }
      expiry = Date.parse(grant.expires_at); workerGeneration = grant.worker_generation; armAuthority()
    },
    media(factory: OriginalMediaFactory, callbacks: SpeechMediaCallbacks): SpeechMediaPort {
      const port = factory(callbacks, input!.track, context), setMicrophone = port.setMicrophone.bind(port)
      port.setMicrophone = async (enabled, cancellation) => {
        await setMicrophone(enabled, cancellation)
        if (enabled) publishedTrack = port.microphonePublication?.() ?? undefined
      }
      return port
    },
    async start() {
      if (closed || started || finished || Date.now() >= expiry) throw Error('original_capture_finished_or_expired')
      await input!.start(); started = true
    },
    async finish() {
      if (finished) return
      await input!.finish(); finished = true
      update('Microphone stopped. Original audio is retained until verified publication.')
    },
    close() {
      if (retirement) return retirement
      closed = true
      if (timer) clearTimeout(timer)
      if (authorityTimer) clearTimeout(authorityTimer)
      cancellation.abort()
      retirement = (async () => {
        const results = await Promise.allSettled([input!.finish().finally(() => input!.close()), polling])
        const archivesClosed = await Promise.allSettled([...archives.values()].map(archive => archive.close()))
        const failed = [...results, ...archivesClosed].find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      })()
      return retirement
    },
  }
}
