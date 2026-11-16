import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebSpeechCaptureInput } from '../speechCaptureInput.ts'

test('nonrecording microphone delivers original frames without a durable archive', async () => {
  const originals = ['AudioContext', 'AudioWorkletNode', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  let worklet: any
  const track = { enabled: false, onended: null, stop() {} }
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] }
  class Context {
    sampleRate = 48000; state = 'running'; onstatechange = null
    audioWorklet = { async addModule() {} }
    createMediaStreamDestination() { return { stream, disconnect() {} } }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    async resume() {} async close() { this.state = 'closed' }
  }
  class Worklet {
    onprocessorerror = null
    port = { onmessage: null as any, close() {}, postMessage(value: any) {
      if (value.type === 'stop') queueMicrotask(() => worklet.port.onmessage({ data: { type: 'ended', samples: 2 } }))
    } }
    constructor() { worklet = this }
    connect() {} disconnect() {}
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context })
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: Worklet })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { async getUserMedia() { return stream } } } })
  try {
    const frames: number[][] = []
    const capture = await createWebSpeechCaptureInput({ onAudio(first, bytes) { frames.push([first, ...bytes]) } })
    await capture.start()
    const bytes = new Uint8Array([1, 0, 2, 0])
    worklet.port.onmessage({ data: { type: 'live', firstSample: 0, bytes: bytes.buffer } })
    worklet.port.onmessage({ data: { type: 'chunk', firstSample: 0, bytes: new Uint8Array([1, 0, 2, 0]).buffer } })
    assert.deepEqual(frames, [[0, 1, 0, 2, 0]]); assert.ok(capture.capturing)
    assert.deepEqual([...bytes], [0, 0, 0, 0])
    await capture.finish(); await capture.close(); assert.equal(capture.capturing, false)
  } finally {
    for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
  }
})
