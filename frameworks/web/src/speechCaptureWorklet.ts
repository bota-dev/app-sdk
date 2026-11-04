// This module runs only in an AudioWorkletGlobalScope. No network, keys or
// storage enter the render thread. Four credits bound outstanding PCM buffers.
declare const sampleRate: number
declare class AudioWorkletProcessor { readonly port: MessagePort }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void

class SpeechCaptureProcessor extends AudioWorkletProcessor {
  private samples = 0
  private firstSample = 0
  private used = 0
  private buffer = new ArrayBuffer(96000)
  private view = new DataView(this.buffer)
  private credits = 4
  private stopped = false
  constructor() {
    super()
    if (sampleRate !== 48000) throw Error('speech_capture_sample_rate')
    this.port.onmessage = event => {
      if (event.data?.type === 'credit') this.credits = Math.min(4, this.credits + 1)
      if (event.data?.type === 'stop') this.stop()
    }
  }
  private flush() {
    if (!this.used) return
    if (this.credits > 0) {
      const bytes = this.used === 48000 ? this.buffer : this.buffer.slice(0, this.used * 2)
      this.port.postMessage({ type: 'chunk', firstSample: this.firstSample, bytes }, [bytes])
      this.credits--
      this.buffer = new ArrayBuffer(96000); this.view = new DataView(this.buffer)
    }
    this.used = 0
  }
  private stop() {
    if (this.stopped) return
    this.stopped = true; this.flush()
    this.port.postMessage({ type: 'ended', samples: this.samples })
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0]
    if (!output) return !this.stopped
    output.fill(0)
    if (this.stopped) return false
    const input = inputs[0]?.[0]
    if (!input || input.length !== output.length) {
      this.flush(); this.samples += output.length
      if (this.samples >= 345600000) this.stop()
      return !this.stopped
    }
    for (let i = 0; i < input.length; i++) {
      if (this.samples >= 345600000) { this.stop(); break }
      const value = input[i]!, pcm = Number.isFinite(value) ? Math.max(-32768, Math.min(32767, Math.round(value * 32768))) : 0
      // RTC receives precisely the quantized original, before its own codec.
      output[i] = pcm / 32768
      if (this.used === 0) this.firstSample = this.samples
      this.view.setInt16(this.used * 2, pcm, true)
      this.samples++; this.used++
      if (this.used === 48000) this.flush()
    }
    return !this.stopped
  }
}
registerProcessor('bota-speech-capture-v1', SpeechCaptureProcessor)
export {}
