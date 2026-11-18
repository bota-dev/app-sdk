import initWasm, { recordingSpeech } from './generated/bota_device_sdk_core.js'
export { WebRecordingSpeechPlayback } from './recordingSpeechPlayback.ts'

/** Opaque server-catalog choices passed to the authenticated host at activity
 * creation. Omission inherits defaults; these fields never activate a stage. */
export interface RecordingSpeechModelSelection {
  models?: { asr?: string; translation?: string; tts?: string }
  model_catalog_revision?: string
}
export interface RecordingSpeechModelIdentity {
  id: string; revision: string; label: string; selection: 'explicit' | 'default'
}

export interface RecordingSpeechConfiguration {
  projectId: string; activityId: string; endpoint: string;
  /** Required when grant generation is greater than one. Snapshot the current
   * capture cursor and buffer only subsequent frames until ready. */
  resume?: { sourceId: string; sample: number }[]
}
export interface RecordingSpeechGrant {
  version: 1; project_id: string; activity_id: string; transport: 'websocket'; protocol: 'bota.recording-speech.v1';
  url: string; token: string; generation: number; expires_at: string
}
export interface RecordingSpeechCaption {
  unitId: string; sourceId: string; sourceEpoch: number; revision: number; startSample: number; endSample: number;
  sourceLanguage: string; targetLanguage?: string; text: string
}
export interface RecordingSpeechPlayback {
  /** Complete only after queued/scheduled output has actually been cleared. */
  clear(): Promise<void>
  /** Copy or consume synchronously. False means the playback queue is full. */
  play(pcm: Uint8Array, outputId: string, offsetSamples: number): boolean
  drain(): Promise<void>
}
export interface WebRecordingSpeechOptions {
  configuration: RecordingSpeechConfiguration; grant: RecordingSpeechGrant; playback: RecordingSpeechPlayback;
  wasm?: ArrayBuffer | Uint8Array | WebAssembly.Module; signal?: AbortSignal;
  socketFactory?(url: string, protocol: string): WebSocket;
  onCaption?(caption: RecordingSpeechCaption, final: boolean): void;
  onStatus?(code: 'interrupted' | 'playback_unavailable' | 'output_skipped'): void;
}
export interface WebRecordingSpeech {
  readonly ready: Promise<void>
  readonly active: boolean
  /** Borrowed original PCM16LE at 48 kHz, from the same capture as the archive. */
  push(sourceIndex: number, firstSample: number, pcm: Uint8Array): boolean
  bindMicrophone(clockId: string): void
  changeTarget(language: string, requestId: string): Promise<void>
  setRoute(route: 'headphones' | 'unqualified'): Promise<void>
  finish(): Promise<void>
  close(): Promise<void>
}
interface PolicyState {
  generation: number; target: { revision: number; language: string }; pending: unknown;
  ready: boolean; finishing: boolean; closed: boolean
}
interface Decision { state: PolicyState; control?: object; header?: number[]; accepted?: boolean; clearPlayback?: boolean; url?: string; protocol?: string }
const fail = () => Error('recording_speech_unavailable')
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true })
function deferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void
  const promise = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse })
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}

/** Direct transport owns only live processing. Closing this owner never stops
 * the capture source, closes its archive, deletes ciphertext, or replays audio. */
export async function createWebRecordingSpeech(options: WebRecordingSpeechOptions): Promise<WebRecordingSpeech> {
  if (options.signal?.aborted) throw fail()
  const wasm = options.wasm instanceof Uint8Array ? new Uint8Array(options.wasm).buffer : options.wasm
  await initWasm(wasm === undefined ? undefined : { module_or_path: wasm })
  if (options.signal?.aborted) throw fail()
  const initial = JSON.parse(recordingSpeech(JSON.stringify({ op: 'create', configuration: options.configuration, grant: options.grant, nowMs: Date.now() }))) as Decision
  let state = initial.state, stopped = false, finished = false, incoming = Promise.resolve(), queuedBytes = 0, queuedCount = 0
  let closePromise: Promise<void> | undefined, change = deferred(), finish = deferred(), changing = false
  let changeTimeout: ReturnType<typeof setTimeout> | undefined
  const ready = deferred(), pending: { index: number; first: number; bytes: Uint8Array<ArrayBuffer> }[] = []
  let pendingBytes = 0
  const socket = options.socketFactory?.(initial.url!, initial.protocol!) ?? new WebSocket(initial.url!, initial.protocol!)
  socket.binaryType = 'arraybuffer'
  const status = (code: Parameters<NonNullable<WebRecordingSpeechOptions['onStatus']>>[0]) => { try { options.onStatus?.(code) } catch { /* Observer failure does not own capture. */ } }
  const step = (command: object) => {
    const decision = JSON.parse(recordingSpeech(JSON.stringify({ ...command, state }))) as Decision
    state = decision.state; return decision
  }
  const send = (value: object | ArrayBuffer) => {
    if (stopped || socket.readyState !== 1 || socket.bufferedAmount > 192000) throw fail()
    socket.send(value instanceof ArrayBuffer ? value : JSON.stringify(value))
  }
  const discard = () => { for (const frame of pending) frame.bytes.fill(0); pending.length = 0; pendingBytes = 0 }
  const abort = () => { void close().catch(() => undefined) }
  const deadline = setTimeout(abort, 10000)
  const reject = () => { ready.reject(fail()); change.reject(fail()); finish.reject(fail()) }
  const silence = async () => { try { await options.playback.clear() } catch { status('playback_unavailable'); throw fail() } }
  function close(): Promise<void> {
    if (closePromise) return closePromise
    stopped = true; clearTimeout(deadline); clearTimeout(changeTimeout); discard(); reject(); options.signal?.removeEventListener('abort', abort)
    const accepted = incoming
    closePromise = (async () => { await silence(); await accepted })(); socket.close(); return closePromise
  }
  const interrupt = () => { if (!stopped) status('interrupted'); void close().catch(() => undefined) }
  function push(index: number, first: number, pcm: Uint8Array): boolean {
    if (stopped || !state.ready || state.finishing || !pcm.length || pcm.length > 9600 || pcm.length % 2) return false
    try {
      if (state.pending) {
        if (pendingBytes + pcm.length > 38400) throw fail()
        pending.push({ index, first, bytes: new Uint8Array(pcm) }); pendingBytes += pcm.length; return true
      }
      const decision = step({ op: 'frame', sourceIndex: index, firstSample: first, samples: pcm.length / 2 })
      const bytes = new Uint8Array(32 + pcm.length); bytes.set(decision.header!); bytes.set(pcm, 32)
      send(bytes.buffer); return true
    } catch { interrupt(); return false }
  }
  const clearAndAcknowledge = async () => {
    await silence(); if (stopped) throw fail()
    send(step({ op: 'playback_cleared', revision: state.target.revision }).control!)
  }
  const receive = async (data: string | ArrayBuffer) => {
    if (stopped) return
    if (data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(data), view = new DataView(data)
      if (bytes.length < 18 || decoder.decode(bytes.subarray(0, 4)) !== 'BRT1') throw fail()
      const idBytes = view.getUint16(4, true), header = view.getUint16(6, true), offset = Number(view.getBigUint64(8, true))
      if (idBytes > 256 || header !== 16 + idBytes || bytes.length <= header || (bytes.length - header) % 2 || !Number.isSafeInteger(offset)) throw fail()
      const outputId = decoder.decode(bytes.subarray(16, header)), pcm = bytes.subarray(header)
      const accepted = step({ op: 'audio_chunk', outputId, offsetSamples: offset, samples: pcm.length / 2 }).accepted
      if (accepted && !options.playback.play(pcm, outputId, offset)) {
        step({ op: 'clear' }); await silence(); status('output_skipped')
      }
      pcm.fill(0); return
    }
    if (typeof data !== 'string' || encoder.encode(data).length > 32768) throw fail()
    const value = JSON.parse(data) as Record<string, any>
    if (value.type === 'ready') {
      step({ op: 'ready', event: value, nowMs: Date.now() }); await clearAndAcknowledge(); clearTimeout(deadline); ready.resolve(); return
    }
    if (!state.ready || value.activityId !== options.configuration.activityId || value.generation !== state.generation) throw fail()
    if (value.type === 'target_committed') {
      step({ op: 'target_committed', requestId: value.requestId, revision: value.target?.revision, language: value.target?.language })
      await clearAndAcknowledge()
      for (const frame of pending.splice(0)) { pendingBytes -= frame.bytes.length; const accepted = push(frame.index, frame.first, frame.bytes); frame.bytes.fill(0); if (!accepted) throw fail() }
      changing = false; clearTimeout(changeTimeout); change.resolve(); return
    }
    if (value.type === 'audio_clear') { step({ op: 'clear' }); await silence(); return }
    if (value.type === 'audio_start') {
      if (value.sampleRate !== 24000) throw fail()
      step({ op: 'audio_start', activityId: value.activityId, generation: value.generation, revision: value.revision, outputId: value.outputId }); return
    }
    if (value.type === 'audio_end') { step({ op: 'audio_end', outputId: value.outputId, samples: value.samples }); return }
    if (value.type === 'caption') {
      const caption = value.caption as RecordingSpeechCaption
      if (typeof caption?.text !== 'string' || typeof value.final !== 'boolean' || value.revision !== caption.revision) throw fail()
      const accepted = step({ op: 'caption', activityId: value.activityId, generation: value.generation, revision: caption.revision,
        sourceId: caption.sourceId, sourceEpoch: caption.sourceEpoch, unitId: caption.unitId, startSample: caption.startSample, endSample: caption.endSample,
        sourceLanguage: caption.sourceLanguage, targetLanguage: caption.targetLanguage ?? null, textBytes: encoder.encode(caption.text).length }).accepted
      if (accepted) { try { options.onCaption?.(Object.freeze({ ...caption }), value.final) } catch { /* Observers cannot stop original capture. */ } }
      return
    }
    if (value.type === 'finished') { finished = true; await options.playback.drain(); finish.resolve(); return }
    if (value.type === 'status') { status('interrupted'); return }
    throw fail()
  }
  socket.addEventListener('open', () => { try { send(initial.control!); delete initial.control } catch { interrupt() } }, { once: true })
  socket.addEventListener('message', event => {
    const data = (event as MessageEvent).data as string | ArrayBuffer
    const size = typeof data === 'string' ? encoder.encode(data).length : data instanceof ArrayBuffer ? data.byteLength : 32769
    if (stopped || size > 32768 || ++queuedCount > 64 || (queuedBytes += size) > 192000) { interrupt(); return }
    incoming = incoming.then(() => receive(data)).catch(interrupt).finally(() => { queuedCount--; queuedBytes -= size })
  })
  socket.addEventListener('error', interrupt)
  socket.addEventListener('close', () => {
    void incoming.then(() => {
      if (finished) { stopped = true; clearTimeout(deadline); options.signal?.removeEventListener('abort', abort) }
      else interrupt()
    })
  })
  options.signal?.addEventListener('abort', abort, { once: true })
  return {
    ready: ready.promise, get active() { return state.ready && !stopped && !state.finishing }, push,
    bindMicrophone(clockId) { step({ op: 'bind_microphone', clockId }) },
    async changeTarget(language, requestId) {
      if (stopped || changing) throw fail()
      const decision = step({ op: 'target', language, requestId }); changing = true; change = deferred()
      changeTimeout = setTimeout(interrupt, 15000)
      try { await silence(); send(decision.control!) } catch { interrupt(); throw fail() }
      return change.promise
    },
    async setRoute(route) {
      const decision = step({ op: 'route', route }); if (decision.clearPlayback) await silence(); send(decision.control!)
    },
    async finish() {
      if (stopped) throw fail()
      send(step({ op: 'finish' }).control!)
      const timeout = setTimeout(interrupt, 60000)
      try { await finish.promise } finally { clearTimeout(timeout) }
    }, close,
  }
}

/** Headphone playout with one bounded scheduler. Route qualification belongs to
 * the host; the browser does not infer headphones from a device label. */
export function createWebRecordingPlayback(context: AudioContext): RecordingSpeechPlayback {
  const nodes = new Set<AudioBufferSourceNode>(), ends = new Set<Promise<void>>()
  const dispose = new Map<AudioBufferSourceNode, () => void>()
  let tail = 0
  return {
    async clear() {
      for (const node of [...nodes]) { try { node.stop() } catch { /* Already ended. */ } dispose.get(node)?.() }
      tail = context.currentTime
    },
    play(pcm) {
      if (context.state !== 'running' || !pcm.length || pcm.length % 2 || Math.max(tail, context.currentTime) - context.currentTime + pcm.length / 48000 > 1) return false
      const buffer = context.createBuffer(1, pcm.length / 2, 24000), channel = buffer.getChannelData(0), data = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
      for (let i = 0; i < channel.length; i++) channel[i] = data.getInt16(i * 2, true) / 32768
      const node = context.createBufferSource(); node.buffer = buffer; node.connect(context.destination); nodes.add(node)
      let resolve!: () => void; const ended = new Promise<void>(done => { resolve = done }); ends.add(ended)
      const release = () => { node.onended = null; node.disconnect(); node.buffer = null; nodes.delete(node); dispose.delete(node); ends.delete(ended); channel.fill(0); resolve() }
      dispose.set(node, release); node.onended = release
      const start = Math.max(context.currentTime, tail); tail = start + buffer.duration; node.start(start); return true
    },
    async drain() { await Promise.all([...ends]) },
  }
}
