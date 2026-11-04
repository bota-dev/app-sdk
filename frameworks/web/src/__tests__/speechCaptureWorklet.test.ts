import assert from 'node:assert/strict'
import test from 'node:test'

test('one quantized sample stream feeds RTC and bounded archival, preserving dropped positions', async () => {
  const messages: { type: string; firstSample?: number; bytes?: ArrayBuffer; samples?: number }[] = []
  let Processor: new () => { port: { onmessage: (event: { data: unknown }) => void }; process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean }
  Object.assign(globalThis, { sampleRate: 48000, AudioWorkletProcessor: class {
    port = { onmessage: () => {}, postMessage: (value: typeof messages[number]) => messages.push(value) }
  }, registerProcessor: (_name: string, constructor: typeof Processor) => { Processor = constructor } })
  await import('../speechCaptureWorklet.ts')
  const processor = new Processor!()
  const input = Float32Array.from({ length: 128 }, (_, i) => (i - 64) / 70), output = new Float32Array(128)
  for (let sample = 0; sample < 48000 * 6; sample += 128) processor.process([[input]], [[output]])
  assert.equal(messages.length, 4)
  const bytes = new DataView(messages[0]!.bytes!)
  for (let i = 0; i < 128; i++) assert.equal(output[i], bytes.getInt16(i * 2, true) / 32768)
  processor.port.onmessage({ data: { type: 'credit' } })
  for (let sample = 0; sample < 48000; sample += 128) processor.process([[input]], [[output]])
  assert.equal(messages.length, 5)
  assert.equal(messages[4]!.firstSample, 48000 * 6)
  processor.port.onmessage({ data: { type: 'stop' } })
  assert.deepEqual(messages.at(-1), { type: 'ended', samples: 48000 * 7 })
  assert.equal(processor.process([[input]], [[output]]), false)
  assert.ok(output.every(value => value === 0))
})
