import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { createWebSpeechCapture, recoverWebSpeechCapture, listWebSpeechCaptures, listWebSpeechCaptureReceipts } from '../speechCapture.ts'

const wasm = await readFile(new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url))
const scope = 'prj_fixture/session/member/1/user-generation-1'
const captureId = '10000000-0000-4000-8000-000000000001'
const clockId = '20000000-0000-4000-8000-000000000001'
const raw = new Uint8Array(32).fill(7)
test('WebCrypto decrypts the canonical native and backend capture vector', async () => {
  const bytes = await readFile(new URL('../../../../protocol/speech-session/capture-v1.json', import.meta.url))
  assert.equal(Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex'), '4554c3bcadcf7a54e01ad34edd07b3b97e1cc8276e0b1d0b4fbb795c37035009')
  const fixture = JSON.parse(bytes.toString())
  const key = await crypto.subtle.importKey('raw', Buffer.from(fixture.key, 'base64'), 'AES-GCM', false, ['decrypt'])
  for (const chunk of fixture.chunks) {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(chunk.packet.nonce, 'base64'),
      additionalData: Buffer.from(chunk.aad, 'base64') }, key, Buffer.from(chunk.packet.ciphertext, 'base64'))
    assert.equal(Buffer.from(plain).toString('hex'), chunk.pcmHex)
  }
  const manifest = fixture.manifest
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(manifest.packet.nonce, 'base64'),
    additionalData: Buffer.from(manifest.aad, 'base64') }, key, Buffer.from(manifest.packet.ciphertext, 'base64'))
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), manifest.value)
})
const prepared = { protocol_version: 1, profile: 'speech_capture_pcm_v1', capture_id: captureId,
  recording_id: 'rec_fixture', sample_rate: 48000, channels: 1, format: 'pcm_s16le', cipher: 'AES-256-GCM',
  data_key: Buffer.from(raw).toString('base64'), maximum_chunk_samples: 48000,
  upload_until: new Date(Date.now() + 60000).toISOString() }
function environment() {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() })
  Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, value: IDBKeyRange })
  const held = new Set<string>()
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    storage: { persist: async () => true }, locks: { async request(name: string, _options: unknown, work: (lock: object | null) => Promise<void>) {
      if (held.has(name)) return work(null)
      held.add(name)
      try { await work({ name }) } finally { held.delete(name) }
    } },
  } })
}
test('original capture survives interrupted upload; deletion requires its exact verified receipt', async () => {
  environment()
  let archive = await createWebSpeechCapture({ scope, prepared, wasm })
  await assert.rejects(createWebSpeechCapture({ scope, prepared, wasm }))
  await archive.beginClock(clockId)
  await archive.append(0, new Uint8Array([1, 0, 2, 0]))
  await archive.append(5, new Uint8Array([3, 0]))
  await archive.endClock(8)
  await archive.finish()
  let uploads = 0, completion: { nonce: string; ciphertext: string } | undefined
  const host = {
    async upload(packet: { header: { sequence: number; firstSample: number; samples: number; archiveSample: number }; nonce: string; ciphertext: string }, _signal: AbortSignal) {
      uploads++
      const numbers = Buffer.alloc(24)
      numbers.writeUInt32BE(packet.header.sequence); numbers.writeBigUInt64BE(BigInt(packet.header.firstSample), 4)
      numbers.writeUInt32BE(packet.header.samples, 12); numbers.writeBigUInt64BE(BigInt(packet.header.archiveSample), 16)
      const aad = Buffer.concat([Buffer.from('bota.speech.capture.chunk.v1\0'), Buffer.from(captureId.replaceAll('-', ''), 'hex'),
        Buffer.from(clockId.replaceAll('-', ''), 'hex'), numbers])
      const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.concat([aad, Buffer.from(packet.nonce, 'base64'), Buffer.from(packet.ciphertext, 'base64')]))).toString('hex')
      return { sequence: packet.header.sequence, sha256, stored: true }
    },
    async complete(packet: { nonce: string; ciphertext: string }) { completion = packet; throw Error('offline') },
    async status() { return { state: 'open' } },
  }
  await assert.rejects(archive.flush(host, new AbortController().signal), /offline/)
  assert.equal(uploads, 2)
  await archive.close()
  archive = await recoverWebSpeechCapture({ scope, captureId, wasm })
  assert.equal((await listWebSpeechCaptures(scope)).length, 1)
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
  const aad = Buffer.concat([Buffer.from('bota.speech.capture.manifest.v1\0'), Buffer.from(captureId.replaceAll('-', ''), 'hex')])
  const manifest = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM',
    iv: Buffer.from(completion!.nonce, 'base64'), additionalData: aad }, key, Buffer.from(completion!.ciphertext, 'base64'))))
  assert.equal(manifest.archiveSamples, 3)
  assert.deepEqual(manifest.clocks, [{ id: clockId, samples: 8, endKnown: true }])
  const manifestSha256 = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(completion!.nonce + '\0' + completion!.ciphertext))).toString('hex')
  const receipt = { profile: 'speech_capture_pcm_v1', capture_id: captureId, recording_id: prepared.recording_id,
    state: 'published', audio_verification: 'verified', archive_samples: 3, manifest_sha256: manifestSha256, content_sha256: 'ab'.repeat(32) }
  await assert.rejects(archive.flush({ ...host, status: async () => ({ ...receipt, recording_id: 'rec_other' }) }, new AbortController().signal))
  assert.equal((await listWebSpeechCaptures(scope)).length, 1)
  assert.deepEqual(await archive.flush({ ...host, status: async () => receipt }, new AbortController().signal), receipt)
  assert.equal(uploads, 2)
  assert.equal((await listWebSpeechCaptures(scope)).length, 0)
  assert.deepEqual(await listWebSpeechCaptureReceipts(scope), [{ captureId, recordingId: prepared.recording_id }])
  await archive.close()
  await assert.rejects(createWebSpeechCapture({ scope, prepared, wasm }))
})

test('crash recovery preserves an unknown clock tail and refuses another scope', async () => {
  environment()
  const archive = await createWebSpeechCapture({ scope, prepared, wasm })
  await archive.beginClock(clockId)
  await archive.append(0, new Uint8Array([1, 0]))
  await archive.close()
  Object.assign(navigator.storage, { persist: async () => false })
  await assert.rejects(recoverWebSpeechCapture({ scope: 'other-owner', captureId, wasm }))
  const recovered = await recoverWebSpeechCapture({ scope, captureId, wasm })
  assert.equal(recovered.snapshot.finished, true)
  assert.deepEqual(recovered.snapshot.clocks, [{ id: clockId, samples: 1, endKnown: false }])
  await assert.rejects(recovered.beginClock(crypto.randomUUID()))
  await recovered.close()
})

test('closing an archive fences a host that ignores cancellation without deleting retained data', async () => {
  environment()
  const archive = await createWebSpeechCapture({ scope, prepared, wasm })
  let enter!: () => void, settle!: (value: unknown) => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const pending = archive.flush({ status: () => { enter(); return new Promise(resolve => { settle = resolve }) },
    upload: async () => { throw Error('unexpected') }, complete: async () => { throw Error('unexpected') } }, new AbortController().signal)
  const observed = pending.catch(() => undefined)
  await entered
  const closing = archive.close()
  const result = await Promise.race([closing.then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('timeout'), 100))])
  settle({ state: 'open' }); await observed; await closing
  assert.equal(result, 'closed')
  assert.equal((await listWebSpeechCaptures(scope)).length, 1)
})
