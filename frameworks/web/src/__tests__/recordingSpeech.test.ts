import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createWebRecordingSpeech } from '../recordingSpeech.ts'

test('direct Web owner sends same-source PCM, holds direction changes, and keeps archive ownership outside transport', async () => {
  const id = '11111111-1111-4111-8111-111111111111', sent: (string | ArrayBuffer)[] = [], played: Uint8Array[] = []
  let socket!: FakeSocket, clears = 0
  class FakeSocket extends EventTarget {
    readyState = 0; bufferedAmount = 0; binaryType = 'arraybuffer'
    send(value: string | ArrayBuffer) { sent.push(value) }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
    message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' || value instanceof ArrayBuffer ? value : JSON.stringify(value) })) }
  }
  const wasm = await readFile(new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url))
  const owner = await createWebRecordingSpeech({ configuration: { projectId: 'prj_test', activityId: id, endpoint: 'wss://api.example.com/v1/recording-speech/ws' },
    grant: { version: 1, project_id: 'prj_test', activity_id: id, transport: 'websocket', protocol: 'bota.recording-speech.v1',
      url: 'wss://api.example.com/v1/recording-speech/ws', token: 'a'.repeat(43), generation: 1, expires_at: new Date(Date.now() + 20000).toISOString() }, wasm,
    socketFactory: () => { socket = new FakeSocket(); return socket as unknown as WebSocket },
    playback: { async clear() { clears++ }, play(bytes) { played.push(new Uint8Array(bytes)); return true }, async drain() {} },
  })
  socket.readyState = 1; socket.dispatchEvent(new Event('open'))
  assert.equal(JSON.parse(sent[0] as string).type, 'authenticate')
  socket.message({ type: 'ready', version: 1, activityId: id, generation: 1, target: { revision: 1, language: 'zh' },
    sources: [{ id: 'mixed', epoch: 1, role: 'mixed', speaker: 'unknown', language: 'en', startSample: 0 }],
    input: { format: 'pcm_s16le', sampleRate: 48000, maxFrameSamples: 4800 }, playbackRoute: 'unqualified' })
  await owner.ready; await owner.setRoute('headphones')
  assert.equal(owner.push(0, 0, new Uint8Array([1, 0, 2, 0])), true)
  const frame = new Uint8Array(sent.find(value => value instanceof ArrayBuffer) as ArrayBuffer)
  assert.equal(new TextDecoder().decode(frame.subarray(0, 4)), 'BRS1')
  assert.deepEqual(Array.from(frame.subarray(32)), [1, 0, 2, 0])
  const target = owner.changeTarget('en', 'change-1')
  assert.equal(owner.push(0, 2, new Uint8Array([3, 0])), true)
  await new Promise(resolve => setImmediate(resolve))
  const control = sent.filter(value => typeof value === 'string').map(value => JSON.parse(value as string)).find(value => value.type === 'target')
  assert.equal(control.change.boundaries[0].sample, 2)
  socket.message({ type: 'target_committed', activityId: id, generation: 1, requestId: 'change-1', target: { revision: 2, language: 'en' } })
  await target
  assert.ok(sent.some(value => typeof value === 'string' && JSON.parse(value).type === 'playback_ack' && JSON.parse(value).revision === 2))
  assert.ok(clears >= 3)
  const old = `${id}:1:1:mixed:1:1:1:zh:speech`
  socket.message({ type: 'audio_start', activityId: id, generation: 1, revision: 1, outputId: old, sampleRate: 24000 })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(played.length, 0)
  const ending = owner.finish(), outputId = `${id}:1:2:mixed:1:1:1:en:speech`
  socket.message({ type: 'audio_start', activityId: id, generation: 1, revision: 2, outputId, sampleRate: 24000 })
  const outputName = new TextEncoder().encode(outputId), binary = new Uint8Array(16 + outputName.length + 4), view = new DataView(binary.buffer)
  binary.set(new TextEncoder().encode('BRT1')); view.setUint16(4, outputName.length, true); view.setUint16(6, 16 + outputName.length, true)
  binary.set(outputName, 16); binary.set([7, 0, 8, 0], 16 + outputName.length); socket.message(binary.buffer)
  socket.message({ type: 'audio_end', activityId: id, generation: 1, revision: 2, outputId, samples: 2 })
  socket.message({ type: 'finished', activityId: id, generation: 1 })
  await ending; assert.deepEqual(Array.from(played[0]!), [7, 0, 8, 0])
  await owner.close()
})
