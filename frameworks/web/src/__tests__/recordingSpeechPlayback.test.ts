import assert from 'node:assert/strict'
import test from 'node:test'
import { WebRecordingSpeechPlayback } from '../recordingSpeechPlayback.ts'

test('headphone qualification, one-second pressure and route loss clear actual scheduled buffers', async () => {
  const devices = new EventTarget(); Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: devices } })
  let route = true, cleared = 0, lost = 0
  const arrays: Float32Array[] = []
  const context = { state: 'running', currentTime: 0, destination: {}, resume: async () => {}, close: async () => {},
    createBuffer: (_: number, samples: number) => { const data = new Float32Array(samples); arrays.push(data); return { getChannelData: () => data } },
    createBufferSource: () => ({ connect() {}, disconnect() {}, start() {}, stop() { cleared++ }, onended: null, buffer: null }) }
  const player = new WebRecordingSpeechPlayback(() => route, () => lost++, context as unknown as AudioContext)
  const pcm = new Uint8Array(24000).fill(127)
  assert.equal(player.play(pcm, 'unit', 0), false)
  assert.equal(await player.qualifyHeadphones(), true)
  assert.equal(player.play(pcm, 'unit', 0), true)
  assert.equal(player.play(pcm, 'unit', 12000), true)
  assert.equal(player.play(pcm, 'unit', 24000), false)
  route = false
  assert.equal(player.play(pcm, 'unit', 24000), false)
  assert.equal(lost, 1); assert.equal(cleared, 2); assert.ok(arrays.every(data => data.every(value => value === 0)))
  route = true; assert.equal(player.play(pcm, 'unit', 0), false)
  await player.qualifyHeadphones(); assert.equal(player.play(pcm, 'unit', 0), true)
  devices.dispatchEvent(new Event('devicechange')); assert.equal(player.play(pcm, 'unit', 0), false)
  assert.equal(cleared, 3); await player.close()
})
