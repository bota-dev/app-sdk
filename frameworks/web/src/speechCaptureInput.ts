import type { WebSpeechCapture } from './speechCapture.ts'

export interface WebSpeechCaptureInputOptions {
  archive: WebSpeechCapture
  /** Serve the packaged speechCaptureWorklet.js under the host's CSP. */
  workletUrl?: string | URL
  onError?(code: 'archive_write_failed' | 'capture_interrupted'): void
}
export interface WebSpeechCaptureInput {
  /** Borrowed, same-source microphone output. RTC must own only its branch. */
  readonly track: MediaStreamTrack
  readonly capturing: boolean
  start(): Promise<void>
  stop(): Promise<void>
  finish(): Promise<void>
  close(): Promise<void>
}

/** One browser microphone and one render clock feed independent RTC and
 * encrypted archival branches. RTC teardown never closes this owner. */
export async function createWebSpeechCaptureInput(options: WebSpeechCaptureInputOptions): Promise<WebSpeechCaptureInput> {
  const context = new AudioContext({ sampleRate: 48000 }), destination = context.createMediaStreamDestination()
  const candidate = destination.stream.getAudioTracks()[0]
  if (context.sampleRate !== 48000 || !candidate) { await context.close(); throw Error('speech_capture_unsupported') }
  const track: MediaStreamTrack = candidate
  try { await context.audioWorklet.addModule(options.workletUrl ?? new URL('./speechCaptureWorklet.js', import.meta.url)) }
  catch (error) { track.stop(); await context.close(); throw error }
  let source: MediaStreamAudioSourceNode | undefined, node: AudioWorkletNode | undefined, stream: MediaStream | undefined
  let serial: Promise<unknown> = Promise.resolve(), writes: Promise<unknown> = Promise.resolve()
  let ended: Promise<number> | undefined, reportEnd: ((samples: number) => void) | undefined
  let capturing = false, closing = false, interrupted = false, retirement: Promise<void> | undefined
  let pending = 0, clock = false
  const report = (code: 'archive_write_failed' | 'capture_interrupted') => { try { options.onError?.(code) } catch { /* Host observers cannot retain capture. */ } }
  const enqueue = <T>(work: () => Promise<T>) => {
    const next = serial.then(work); serial = next.catch(() => undefined); return next
  }
  const interrupt = () => {
    if (!capturing) return
    interrupted = true; track.enabled = false
    for (const microphone of stream?.getTracks() ?? []) microphone.stop()
    report('capture_interrupted')
    void enqueue(stop).catch(() => report('archive_write_failed'))
  }
  context.onstatechange = () => { if (capturing && context.state !== 'running') interrupt() }
  async function stop() {
    if (!clock) return
    capturing = false; track.enabled = false
    let samples: number | undefined
    let cancelTimeout = () => {}
    try {
      if (!interrupted && node && ended) {
        node.port.postMessage({ type: 'stop' })
        // A suspended/crashed render thread cannot provide a trustworthy EOF.
        samples = await Promise.race([ended, new Promise<undefined>(resolve => {
          const timer = setTimeout(() => resolve(undefined), 1500); cancelTimeout = () => clearTimeout(timer)
        })])
      }
    } finally {
      cancelTimeout()
      for (const microphone of stream?.getTracks() ?? []) { microphone.onended = null; microphone.stop() }
      source?.disconnect(); node?.disconnect()
      if (node) { node.port.onmessage = null; node.port.close(); node.onprocessorerror = null }
      stream = undefined; source = undefined; node = undefined
    }
    await writes
    try {
      if (samples === undefined) { await options.archive.interruptClock(); report('capture_interrupted') }
      else await options.archive.endClock(samples)
    } finally { clock = false; reportEnd = undefined; ended = undefined }
  }
  return {
    track,
    get capturing() { return capturing },
    start() {
      return enqueue(async () => {
        if (closing || options.archive.snapshot.finished) throw Error('speech_capture_closed')
        if (capturing) return
        interrupted = false
        try {
          await context.resume()
          stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 48000,
            echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
          if (closing || context.state !== 'running') throw Error('speech_capture_closed')
          await options.archive.beginClock(crypto.randomUUID()); clock = true
          ended = new Promise(resolve => { reportEnd = resolve })
          source = context.createMediaStreamSource(stream)
          node = new AudioWorkletNode(context, 'bota-speech-capture-v1', { numberOfInputs: 1, numberOfOutputs: 1,
            outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' })
          const owned = node
          node.onprocessorerror = interrupt
          node.port.onmessage = event => {
            const value = event.data
            if (value?.type === 'ended' && Number.isSafeInteger(value.samples) && value.samples >= 0) {
              reportEnd?.(value.samples)
              if (capturing) { void enqueue(stop).catch(() => report('archive_write_failed')) }
              return
            }
            if (value?.type !== 'chunk' || !(value.bytes instanceof ArrayBuffer) || value.bytes.byteLength > 96000 ||
              value.bytes.byteLength === 0 || value.bytes.byteLength % 2 !== 0 || !Number.isSafeInteger(value.firstSample) || value.firstSample < 0) { interrupt(); return }
            const bytes = new Uint8Array(value.bytes)
            if (pending >= 4) { bytes.fill(0); interrupt(); return }
            pending++
            const write = options.archive.append(value.firstSample, bytes)
            bytes.fill(0)
            const observed = write.catch(() => report('archive_write_failed')).finally(() => {
              pending--; if (node === owned) owned.port.postMessage({ type: 'credit' })
            })
            writes = Promise.all([writes, observed]).then(() => undefined)
          }
          for (const microphone of stream.getTracks()) microphone.onended = interrupt
          capturing = true; track.enabled = true
          source.connect(node); node.connect(destination)
        } catch (error) {
          interrupted = true
          if (clock) await stop()
          else for (const microphone of stream?.getTracks() ?? []) microphone.stop()
          throw error
        }
      })
    },
    stop: () => enqueue(stop),
    finish: () => enqueue(async () => { await stop(); if (!options.archive.snapshot.finished) await options.archive.finish() }),
    close() {
      if (retirement) return retirement
      closing = true; track.enabled = false
      for (const microphone of stream?.getTracks() ?? []) microphone.stop()
      retirement = enqueue(async () => {
        try { await stop() }
        finally { context.onstatechange = null; track.stop(); destination.disconnect(); await context.close() }
      })
      return retirement
    },
  }
}
