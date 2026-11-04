import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebSpeechCaptureInput } from '../speechCaptureInput.ts'
import type { WebSpeechCapture } from '../speechCapture.ts'

test('microphone ownership joins durable writes before EOF and keeps its RTC output separate', async () => {
  const events: string[] = [], packets: Uint8Array[] = []
  let acquisitions = 0, stopped = 0, closed = 0, microphoneNode: FakeNode | undefined
  const original = { enabled: true, onended: null, stop() { stopped++ } }
  const output = { enabled: true, stop() { events.push('output-stop') } }
  class FakeContext {
    sampleRate = 48000; state = 'suspended'; onstatechange = null
    audioWorklet = { addModule: async () => {} }
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [output] }, disconnect() {} } }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    async resume() { this.state = 'running' }
    async close() { closed++; this.state = 'closed' }
  }
  class FakeNode {
    onprocessorerror = null
    port = { onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (data: { type: string }) => {
        if (data.type === 'stop') this.port.onmessage?.({ data: { type: 'ended', samples: 9 } })
      }, close() {} }
    constructor() { microphoneNode = this }
    connect() {}
    disconnect() {}
  }
  Object.assign(globalThis, { AudioContext: FakeContext, AudioWorkletNode: FakeNode })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getUserMedia: async () => { acquisitions++; return { getTracks: () => [original] } },
  } } })
  let finished = false, write!: () => void
  const archive = {
    get snapshot() { return { finished } }, beginClock: async () => { events.push('begin') },
    append: async (first: number, bytes: Uint8Array) => {
      assert.equal(first, 4); packets.push(new Uint8Array(bytes)); await new Promise<void>(resolve => { write = resolve }); events.push('write')
    },
    endClock: async (samples: number) => { assert.equal(samples, 9); events.push('end') },
    interruptClock: async () => { throw Error('unexpected interruption') },
    finish: async () => { finished = true; events.push('finish') },
  } as unknown as WebSpeechCapture
  const input = await createWebSpeechCaptureInput({ archive })
  assert.equal(acquisitions, 0)
  await input.start(); await input.start()
  assert.equal(acquisitions, 1)
  const pcm = new Uint8Array([1, 0, 2, 0])
  microphoneNode!.port.onmessage!({ data: { type: 'chunk', firstSample: 4, bytes: pcm.buffer } })
  assert.ok(pcm.every(value => value === 0))
  const ending = input.finish()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.ok(!events.includes('end'))
  write(); await ending
  assert.deepEqual(Array.from(packets[0]!), [1, 0, 2, 0])
  assert.deepEqual(events, ['begin', 'write', 'end', 'finish'])
  assert.equal(input.capturing, false); assert.equal(input.track, output)
  assert.equal(stopped, 1); assert.equal(closed, 0)
  await input.close(); await input.close()
  assert.equal(closed, 1)
})
