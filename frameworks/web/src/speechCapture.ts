import initWasm, { speechCapture } from './generated/bota_device_sdk_core.js'

export interface SpeechCapturePacket { nonce: string; ciphertext: string }
export interface SpeechCaptureHeader { sequence: number; clockId: string; firstSample: number; samples: number; archiveSample: number }
export interface SpeechCaptureChunk extends SpeechCapturePacket { header: SpeechCaptureHeader }
export interface SpeechCapturePreparation {
  protocol_version: number; profile: string; capture_id: string; recording_id: string; sample_rate: number;
  channels: number; format: string; cipher: string; data_key: string; maximum_chunk_samples: number; upload_until: string
}
export interface SpeechCaptureHost {
  upload(packet: SpeechCaptureChunk, signal: AbortSignal): Promise<unknown>
  complete(packet: SpeechCapturePacket, signal: AbortSignal): Promise<unknown>
  status(signal: AbortSignal): Promise<unknown>
}
export interface SpeechCaptureSnapshot {
  protocolVersion: number; captureId: string; recordingId: string; archiveSamples: number; nextSequence: number;
  chainSha256: string; clocks: { id: string; samples: number; endKnown: boolean }[]; activeClock: boolean; finished: boolean
}
interface Journal { scope: string; state: SpeechCaptureSnapshot; manifest?: SpeechCapturePacket; manifestSha256?: string }
interface StoredCapture { scope: string; captureId: string; key: CryptoKey; revision: number; journal: SpeechCapturePacket }
interface StoredChunk { scope: string; captureId: string; sequence: number; packet: SpeechCaptureChunk; sha256: string; uploaded: boolean }
interface Options { scope: string; wasm?: ArrayBuffer | Uint8Array | WebAssembly.Module }
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true })
const fail = () => Error('speech_capture_invalid_or_unavailable')
const policy = <T>(command: object): T => JSON.parse(speechCapture(JSON.stringify(command))) as T
function base64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(text)
}
function decode(text: string): Uint8Array<ArrayBuffer> {
  const bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0))
  if (base64(bytes) !== text) throw fail()
  return bytes
}
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { output.set(part, offset); offset += part.length }
  return output
}
async function hash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
}
async function seal(key: CryptoKey, bytes: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer>): Promise<SpeechCapturePacket> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  return { nonce: base64(nonce), ciphertext: base64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
    additionalData: aad, tagLength: 128 }, key, bytes))) }
}
function journalAad(captureId: string): Uint8Array<ArrayBuffer> {
  return decode(policy<{ aad: string }>({ op: 'aad', captureId, kind: 'journal' }).aad)
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(fail()) })
}
function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = transaction.onerror = () => reject(fail())
  })
}
async function database(): Promise<IDBDatabase> {
  const opening = indexedDB.open('bota-speech-capture-v1', 1)
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore('captures', { keyPath: ['scope', 'captureId'] })
    opening.result.createObjectStore('chunks', { keyPath: ['scope', 'captureId', 'sequence'] })
    opening.result.createObjectStore('receipts', { keyPath: ['scope', 'captureId'] })
  }
  return request(opening)
}
async function load(db: IDBDatabase, scope: string, captureId: string): Promise<StoredCapture | undefined> {
  return request(db.transaction('captures').objectStore('captures').get([scope, captureId]))
}
/** An exclusive Web Lock spans this owner, including its network and teardown.
 * IndexedDB revision checks additionally fence stale asynchronous completions. */
async function own(scope: string, captureId: string, creating = false): Promise<() => Promise<void>> {
  if (!scope || scope.length > 512 || !navigator.locks || creating && (!navigator.storage || !await navigator.storage.persist())) throw fail()
  let release!: () => void, granted!: () => void, denied!: (error: unknown) => void
  const acquired = new Promise<void>((resolve, reject) => { granted = resolve; denied = reject })
  const lifetime = new Promise<void>(resolve => { release = resolve })
  const held = navigator.locks.request(`bota-speech-capture:${JSON.stringify([scope, captureId])}`, { ifAvailable: true }, async lock => {
    if (!lock) { denied(fail()); return }
    granted(); await lifetime
  }).catch(denied)
  await acquired
  return async () => { release(); await held }
}
async function initialize(wasm: Options['wasm']) {
  const module = wasm instanceof Uint8Array ? new Uint8Array(wasm).buffer : wasm
  await initWasm(module === undefined ? undefined : { module_or_path: module })
}
function hostCall<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const owned = AbortSignal.any([signal, AbortSignal.timeout(15000)])
  return new Promise<T>((resolve, reject) => {
    const abort = () => { owned.removeEventListener('abort', abort); reject(fail()) }
    if (owned.aborted) { abort(); return }
    owned.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => { owned.throwIfAborted(); return work(owned) }).then(value => {
      if (owned.aborted) abort(); else resolve(value)
    }, reject).finally(() => owned.removeEventListener('abort', abort))
  })
}

/** The host supplies an authenticated account/project/member-generation scope.
 * Enumeration exposes no key, audio or journal and never changes ownership. */
export async function listWebSpeechCaptures(scope: string): Promise<{ captureId: string }[]> {
  if (!scope || scope.length > 512) throw fail()
  const db = await database()
  try {
    const keys = await request(db.transaction('captures').objectStore('captures').getAllKeys(IDBKeyRange.bound([scope, ''], [scope, '\uffff']), 257))
    if (keys.length > 256) throw fail()
    return keys.map(key => ({ captureId: String((key as IDBValidKey[])[1]) }))
  } finally { db.close() }
}

/** Completed identity metadata keeps final transcript retrieval recoverable
 * after verified publication has retired every local audio/key artifact. */
export async function listWebSpeechCaptureReceipts(scope: string): Promise<{ captureId: string; recordingId: string }[]> {
  if (!scope || scope.length > 512) throw fail()
  const db = await database()
  try {
    const rows = await request(db.transaction('receipts').objectStore('receipts').getAll(IDBKeyRange.bound([scope, ''], [scope, '\uffff']), 256))
    return rows.map(row => ({ captureId: String(row.captureId), recordingId: String(row.recordingId) }))
  } finally { db.close() }
}

/** Native WebCrypto keys are non-extractable and persist by structured clone.
 * Only authenticated ciphertext is stored; Rust owns clock and receipt policy.
 * Durable writes are separate from RTC and from upload retries. */
export class WebSpeechCapture {
  private local: Promise<unknown> = Promise.resolve()
  private network: Promise<unknown> | undefined
  private readonly cancellation = new AbortController()
  private closed = false
  private deleted = false
  private closing: Promise<void> | undefined
  private pendingPcm = 0
  private readonly db: IDBDatabase
  private row: StoredCapture
  private journal: Journal
  private readonly release: () => Promise<void>
  private constructor(db: IDBDatabase, row: StoredCapture, journal: Journal, release: () => Promise<void>) {
    this.db = db; this.row = row; this.journal = journal; this.release = release
  }

  static async create(options: Options & { prepared: SpeechCapturePreparation }): Promise<WebSpeechCapture> {
    await initialize(options.wasm)
    const p = options.prepared
    if (p.protocol_version !== 1 || p.profile !== 'speech_capture_pcm_v1' || p.sample_rate !== 48000 || p.channels !== 1 ||
      p.format !== 'pcm_s16le' || p.cipher !== 'AES-256-GCM' || p.maximum_chunk_samples !== 48000 ||
      !Number.isFinite(Date.parse(p.upload_until)) || Date.parse(p.upload_until) <= Date.now()) throw fail()
    const state = policy<SpeechCaptureSnapshot>({ op: 'create', captureId: p.capture_id, recordingId: p.recording_id, retention: 'original_audio_and_text' })
    const release = await own(options.scope, p.capture_id, true)
    let db: IDBDatabase | undefined
    try {
      db = await database()
      if (await load(db, options.scope, p.capture_id) || await request(db.transaction('receipts').objectStore('receipts').get([options.scope, p.capture_id]))) throw fail()
      const raw = decode(p.data_key)
      let key: CryptoKey
      try {
        if (raw.length !== 32) throw fail()
        key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
      } finally { raw.fill(0) }
      const journal: Journal = { scope: options.scope, state }
      const encrypted = await seal(key, encoder.encode(JSON.stringify(journal)), journalAad(p.capture_id))
      const row: StoredCapture = { scope: options.scope, captureId: p.capture_id, key, revision: 0, journal: encrypted }
      const transaction = db.transaction('captures', 'readwrite', { durability: 'strict' }), completion = done(transaction)
      transaction.objectStore('captures').add(row)
      await completion
      return new WebSpeechCapture(db, row, journal, release)
    } catch (error) { db?.close(); await release(); throw error }
  }
  static async recover(options: Options & { captureId: string }): Promise<WebSpeechCapture> {
    await initialize(options.wasm)
    const release = await own(options.scope, options.captureId)
    let db: IDBDatabase | undefined, owner: WebSpeechCapture | undefined
    try {
      db = await database()
      const row = await load(db, options.scope, options.captureId)
      if (!row || row.key.extractable || row.key.algorithm.name !== 'AES-GCM') throw fail()
      const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(row.journal.nonce),
        additionalData: journalAad(options.captureId), tagLength: 128 }, row.key, decode(row.journal.ciphertext)))
      let journal: Journal
      try { journal = JSON.parse(decoder.decode(bytes)) as Journal } finally { bytes.fill(0) }
      journal.state = policy({ op: 'restore', state: journal.state })
      if (journal.scope !== options.scope || journal.state.captureId !== options.captureId) throw fail()
      owner = new WebSpeechCapture(db, row, journal, release)
      if (!journal.state.finished) {
        await owner.change({ ...journal, state: policy({ op: 'recover', state: journal.state }) })
        await owner.finish()
      }
      return owner
    } catch (error) { if (owner) await owner.close(); else { db?.close(); await release() }; throw error }
  }
  get snapshot(): SpeechCaptureSnapshot { return structuredClone(this.journal.state) }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.deleted) return Promise.reject(fail())
    const pending = this.local.then(work)
    this.local = pending.catch(() => undefined)
    return pending
  }
  private async change(journal: Journal, chunk?: StoredChunk): Promise<void> {
    const encrypted = await seal(this.row.key, encoder.encode(JSON.stringify(journal)), journalAad(this.row.captureId))
    const next = { ...this.row, journal: encrypted, revision: this.row.revision + 1 }
    const transaction = this.db.transaction(['captures', 'chunks'], 'readwrite', { durability: 'strict' }), completion = done(transaction)
    const captures = transaction.objectStore('captures'), reading = captures.get([this.row.scope, this.row.captureId])
    reading.onsuccess = () => {
      if (!reading.result || reading.result.revision !== this.row.revision) { transaction.abort(); return }
      captures.put(next)
      if (chunk) transaction.objectStore('chunks').add(chunk)
    }
    await completion
    this.row = next; this.journal = journal
  }
  beginClock(clockId: string): Promise<void> {
    return this.serialize(() => this.change({ ...this.journal, state: policy({ op: 'begin_clock', state: this.journal.state, clockId }) }))
  }
  /** Copies at most one second. The capture pump limits pending calls to four.
   * Successful completion means both ciphertext and its journal are durable. */
  append(firstSample: number, pcm: Uint8Array): Promise<void> {
    if (pcm.length === 0 || pcm.length > 96000 || pcm.length % 2 !== 0 || this.pendingPcm >= 4) return Promise.reject(fail())
    this.pendingPcm++
    const bytes = new Uint8Array(pcm)
    return this.serialize(async () => {
      const planned = policy<{ header: SpeechCaptureHeader; aad: string }>({ op: 'plan', state: this.journal.state, firstSample, samples: bytes.length / 2 })
      const aad = decode(planned.aad), packet = { ...await seal(this.row.key, bytes, aad), header: planned.header }
      const sha256 = await hash(concat(aad, decode(packet.nonce), decode(packet.ciphertext)))
      const state = policy<SpeechCaptureSnapshot>({ op: 'commit', state: this.journal.state, header: packet.header, sha256 })
      await this.change({ ...this.journal, state }, { scope: this.row.scope, captureId: this.row.captureId, sequence: packet.header.sequence,
        packet, sha256, uploaded: false })
    }).finally(() => { bytes.fill(0); this.pendingPcm-- })
  }
  endClock(samples: number): Promise<void> {
    return this.serialize(() => this.change({ ...this.journal, state: policy({ op: 'end_clock', state: this.journal.state, samples }) }))
  }
  /** A lost render thread cannot prove its last sample. */
  interruptClock(): Promise<void> {
    return this.serialize(() => this.change({ ...this.journal, state: policy({ op: 'recover', state: this.journal.state }) }))
  }
  finish(): Promise<void> {
    return this.serialize(async () => {
      if (this.journal.manifest) return
      const value = policy<{ state: SpeechCaptureSnapshot; manifest: unknown; aad: string }>({ op: 'finish', state: this.journal.state })
      const manifest = await seal(this.row.key, encoder.encode(JSON.stringify(value.manifest)), decode(value.aad))
      const manifestSha256 = await hash(encoder.encode(manifest.nonce + '\0' + manifest.ciphertext))
      await this.change({ ...this.journal, state: value.state, manifest, manifestSha256 })
    })
  }
  /** One bounded pass. Hosts schedule retries; an offline server never stalls
   * local capture. Part acknowledgements do not delete local ciphertext. */
  flush(host: SpeechCaptureHost, signal: AbortSignal): Promise<unknown> {
    if (this.closed || this.deleted) return Promise.reject(fail())
    if (this.network) return this.network
    const cancellation = AbortSignal.any([signal, this.cancellation.signal])
    const run = async () => {
      cancellation.throwIfAborted()
      let receipt = await hostCall(cancellation, signal => host.status(signal))
      const published = (value: unknown) => typeof value === 'object' && value !== null && 'state' in value && value.state === 'published'
      if (!published(receipt)) {
        const count = this.journal.state.nextSequence
        for (let sequence = 0; sequence < count; sequence++) {
          cancellation.throwIfAborted()
          const chunk = await request<StoredChunk | undefined>(this.db.transaction('chunks').objectStore('chunks').get([this.row.scope, this.row.captureId, sequence]))
          if (!chunk) throw fail()
          if (chunk.uploaded) continue
          const ack = await hostCall(cancellation, signal => host.upload(chunk.packet, signal))
          cancellation.throwIfAborted()
          if (typeof ack !== 'object' || !ack || !('sequence' in ack) || ack.sequence !== sequence ||
            !('sha256' in ack) || ack.sha256 !== chunk.sha256 || !('stored' in ack) || ack.stored !== true) throw fail()
          const transaction = this.db.transaction('chunks', 'readwrite', { durability: 'strict' }), completion = done(transaction)
          transaction.objectStore('chunks').put({ ...chunk, uploaded: true })
          await completion
        }
        // A concurrently finished capture may have added another final chunk.
        if (this.journal.manifest && count === this.journal.state.nextSequence) {
          const manifest = this.journal.manifest
          receipt = await hostCall(cancellation, signal => host.complete(manifest, signal))
        }
      }
      cancellation.throwIfAborted()
      if (published(receipt)) await this.serialize(async () => {
        policy({ op: 'receipt', state: this.journal.state, manifestSha256: this.journal.manifestSha256, receipt })
        const transaction = this.db.transaction(['captures', 'chunks', 'receipts'], 'readwrite', { durability: 'strict' }), completion = done(transaction)
        transaction.objectStore('receipts').put({ scope: this.row.scope, captureId: this.row.captureId, recordingId: this.journal.state.recordingId })
        transaction.objectStore('captures').delete([this.row.scope, this.row.captureId])
        transaction.objectStore('chunks').delete(IDBKeyRange.bound([this.row.scope, this.row.captureId, 0], [this.row.scope, this.row.captureId, 14399]))
        await completion; this.deleted = true
      })
      return receipt
    }
    this.network = run().finally(() => { this.network = undefined })
    return this.network
  }
  /** Stops IO and releases ownership; retained ciphertext is never discarded. */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true; this.cancellation.abort()
    this.closing = (async () => { await this.local; await this.network?.catch(() => undefined); this.db.close(); await this.release() })()
    return this.closing
  }
}
export const createWebSpeechCapture = WebSpeechCapture.create
export const recoverWebSpeechCapture = WebSpeechCapture.recover
