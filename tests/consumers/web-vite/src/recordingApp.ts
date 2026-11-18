import { createWebRecordingSpeech, WebRecordingSpeechPlayback, type WebRecordingSpeech, type RecordingSpeechCaption, type RecordingSpeechModelSelection } from '@bota.dev/web-app-sdk/speech/recording'
import { createWebSpeechCapture, recoverWebSpeechCapture, listWebSpeechCaptures, listWebSpeechCaptureReceipts, type WebSpeechCapture } from '@bota.dev/web-app-sdk/speech/capture'
import { createWebSpeechCaptureInput } from '@bota.dev/web-app-sdk/speech/capture-input'
import { recordingHost } from './recordingHost'

export async function startRecording(options: { code: string; target: string; retention: string; headphones: () => boolean;
  signal?: AbortSignal; models?: RecordingSpeechModelSelection['models']; modelCatalogRevision?: string;
  caption: (value: RecordingSpeechCaption, final: boolean) => void; status: (value: string) => void;
  final: (captureId: string, sourceVersion: string, segments: Record<string, any>[], translation: string) => void }) {
  const host = recordingHost(options.code), abort = new AbortController(), archives = new Map<string, WebSpeechCapture>()
  const completed = new Map<string, { digest?: string; after: number; segments: Record<string, any>[]; done: boolean }>()
  const activityId = crypto.randomUUID(), clockId = crypto.randomUUID(), original = options.retention === 'original_audio_and_text'
  let live: WebRecordingSpeech | undefined, input: Awaited<ReturnType<typeof createWebSpeechCaptureInput>> | undefined
  let poll: Promise<void> = Promise.resolve(), timer: ReturnType<typeof setTimeout> | undefined, expiry: ReturnType<typeof setTimeout> | undefined
  let closed = false, finishing: Promise<void> | undefined, closing: Promise<void> | undefined
  const retireInput = () => { abort.abort(); void input?.close().catch(() => {}) }
  options.signal?.addEventListener('abort', retireInput, { once: true })
  if (options.signal?.aborted) abort.abort()
  const playback = new WebRecordingSpeechPlayback(options.headphones, () => {
    options.status('Headphone route changed. Translation audio is paused; original capture and captions continue.')
    void live?.setRoute('unqualified').catch(() => {})
  })
  async function update() {
    for (const [id, archive] of archives) {
      if (closed) return
      try {
        const receipt = await archive.flush(host.capture(id), abort.signal) as { state?: string }
        if (receipt.state === 'published') { await archive.close(); archives.delete(id); completed.set(id, { after: 0, segments: [], done: false }) }
      } catch { if (!closed) options.status('Encrypted original retained locally. Upload will retry while this page is open.') }
    }
    for (const [id, page] of completed) {
      if (closed || page.done) continue
      try {
        const value = await host.transcript(id, page.after, page.digest, abort.signal)
        if (value.alignment === 'no_audio' || ['failed','unavailable'].includes(value.state)) {
          page.done = true; options.status(value.alignment === 'no_audio' ? 'No original samples were captured.' : 'Final original text is unavailable. The retained original is preserved.'); continue
        }
        if (value.alignment !== 'verified_original' || value.state !== 'completed' || !Array.isArray(value.segments)) continue
        if (typeof value.result_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.result_sha256) || !Number.isSafeInteger(value.next_segment)) continue
        if (page.digest && page.digest !== value.result_sha256) { page.after = 0; page.segments = []; delete page.digest; continue }
        if (value.next_segment < page.after || value.has_more && value.next_segment === page.after) continue
        page.digest = value.result_sha256; page.after = value.next_segment
        page.segments.push(...value.segments); page.segments = page.segments.slice(-100)
        options.final(id, page.digest!, page.segments, value.final_translation)
        if (!value.has_more) {
          page.done = ['completed','failed'].includes(value.final_translation)
          if (!page.done) { page.after = 0; page.segments = [] }
        }
      } catch { /* Source edits can invalidate the read cursor. Read the fresh version next. */
        page.after = 0; page.segments = []; delete page.digest
        options.final(id, '', [], 'refreshing')
      }
    }
  }
  function schedule() { if (!closed) timer = setTimeout(() => { poll = update().finally(schedule) }, 2000) }
  function finish(): Promise<void> {
    return finishing ??= (async () => {
      clearTimeout(expiry)
      try { await input?.finish() } finally {
        try { if (live?.active) await live.finish() } catch { options.status('Live translation ended with an interruption. Original upload continues.') }
        await host.end(activityId, abort.signal)
      }
      options.status(original ? 'Capture stopped. Waiting for verified original and final text.' : 'Capture stopped. No original audio was retained.'); await poll; await update()
    })()
  }
  function close(): Promise<void> {
    if (closing) return closing
    closed = true; clearTimeout(timer); clearTimeout(expiry); abort.abort()
    options.signal?.removeEventListener('abort', retireInput)
    return closing = (async () => {
      const results = await Promise.allSettled([input?.close(), live?.close(), playback.close(), poll, finishing])
      await Promise.allSettled([...archives.values()].map(value => value.close()))
      await host.end(activityId, AbortSignal.timeout(15000)).catch(() => {})
      if (results.some(result => result.status === 'rejected')) throw Error('recording_cleanup_failed')
    })()
  }
  try {
    const admission = await host.start({ activityId, clockId, ...(original ? { captureId: crypto.randomUUID() } : {}),
      retention: options.retention, ...(options.models ? { models: options.models } : {}),
      ...(options.modelCatalogRevision ? { modelCatalogRevision: options.modelCatalogRevision } : {}), sourceLanguage: 'multi', targetLanguage: options.target }, abort.signal)
    if (original) {
      for (const { captureId } of await listWebSpeechCaptures(admission.scope).catch(() => { options.status('Earlier original storage could not be opened.'); return [] })) {
        try { archives.set(captureId, await recoverWebSpeechCapture({ scope: admission.scope, captureId })) }
        catch { options.status('An earlier encrypted original needs recovery and is retained.') }
      }
      for (const { captureId } of await listWebSpeechCaptureReceipts(admission.scope).catch(() => [])) completed.set(captureId, { after: 0, segments: [], done: false })
    }
    let archive: WebSpeechCapture | undefined
    if (admission.prepared) {
      try { archive = await createWebSpeechCapture({ scope: admission.scope, prepared: admission.prepared }); archives.set(admission.prepared.capture_id, archive) }
      catch { options.status('Original storage is unavailable. Live captions can continue; this capture will not have verified final text.') }
    }
    try {
      live = await createWebRecordingSpeech({ configuration: admission.configuration, grant: admission.grant, playback, signal: abort.signal,
        onCaption: options.caption, onStatus: () => options.status('Live processing was interrupted. Original capture continues.') })
      await live.ready; live.bindMicrophone(clockId)
      await live.setRoute(await playback.qualifyHeadphones() ? 'headphones' : 'unqualified')
    } catch { await live?.close().catch(() => {}); live = undefined; options.status('Live connection unavailable. Original capture continues.') }
    abort.signal.throwIfAborted()
    input = await createWebSpeechCaptureInput({ ...(archive ? { archive } : {}), clockId, liveFrameDurationMs: 100,
      onAudio: (first, pcm) => { live?.push(0, first, pcm) }, onError: code => options.status(code === 'archive_write_failed' ?
        'Original storage interrupted; missing samples remain explicit. Live captions continue.' : 'Microphone interrupted. Original gaps are retained.') })
    abort.signal.throwIfAborted(); await input.start(); abort.signal.throwIfAborted()
    if (live?.active && (!original || archive)) options.status(original ? 'Capturing. Live text remains provisional until the original is verified.' : 'Capturing. Live captions are provisional; original audio is not retained.')
    expiry = setTimeout(() => { void finish().catch(() => options.status('Capture authorization expired.')) }, Math.max(0, Date.parse(admission.activity.expires_at) - Date.now()))
    schedule()
    return { finish, close, changeTarget: async (language: string) => { if (!live?.active) throw Error('live_unavailable'); await live.changeTarget(language, crypto.randomUUID()) },
      qualifyHeadphones: async () => { const qualified = await playback.qualifyHeadphones(); await live?.setRoute(qualified ? 'headphones' : 'unqualified'); return qualified } }
  } catch (error) { await close().catch(() => {}); throw error }
}
