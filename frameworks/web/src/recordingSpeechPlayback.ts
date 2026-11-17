import type { RecordingSpeechPlayback } from './recordingSpeech.ts'

/** Memory-only 24 kHz output. The App supplies a positively qualified headphone
 * route; a device change invalidates it until the App qualifies it again. */
export class WebRecordingSpeechPlayback implements RecordingSpeechPlayback {
  private readonly context: AudioContext
  private readonly queued = new Map<AudioBufferSourceNode, AudioBuffer>()
  private end = 0
  private qualified = false
  private closed = false
  private readonly headphoneRoute: () => boolean
  private readonly onRouteLost: () => void
  private readonly changed = () => { this.qualified = false; void this.clear(); try { this.onRouteLost() } catch { /* Observer cannot retain audio. */ } }
  constructor(headphoneRoute: () => boolean, onRouteLost: () => void = () => {}, context?: AudioContext) {
    this.headphoneRoute = headphoneRoute; this.onRouteLost = onRouteLost
    this.context = context ?? new AudioContext({ sampleRate: 24000 })
    navigator.mediaDevices?.addEventListener('devicechange', this.changed)
  }
  async qualifyHeadphones(): Promise<boolean> {
    if (this.closed) return false
    try { this.qualified = this.headphoneRoute(); if (this.qualified) await this.context.resume() }
    catch { this.qualified = false }
    this.qualified &&= this.context.state === 'running'
    if (!this.qualified) await this.clear()
    return this.qualified
  }
  play(pcm: Uint8Array, _outputId: string, _offsetSamples: number): boolean {
    let route = false
    try { route = this.headphoneRoute() } catch { /* Uncertain route is silent. */ }
    if (this.closed || !this.qualified || !route || this.context.state !== 'running') {
      if (this.qualified) this.changed()
      return false
    }
    if (!pcm.length || pcm.length % 2 || pcm.length > 48000 || this.queued.size >= 64) return false
    const start = Math.max(this.end, this.context.currentTime), duration = pcm.length / 48000
    if (start + duration - this.context.currentTime > 1) return false
    const buffer = this.context.createBuffer(1, pcm.length / 2, 24000), floats = buffer.getChannelData(0)
    const samples = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    for (let i = 0; i < floats.length; i++) floats[i] = samples.getInt16(i * 2, true) / 32768
    const node = this.context.createBufferSource(); node.buffer = buffer
    node.connect(this.context.destination); this.queued.set(node, buffer)
    node.onended = () => { node.disconnect(); floats.fill(0); node.buffer = null; this.queued.delete(node) }
    try { node.start(start); this.end = start + duration; return true }
    catch { node.onended = null; node.disconnect(); floats.fill(0); node.buffer = null; this.queued.delete(node); return false }
  }
  async clear(): Promise<void> {
    for (const [node, buffer] of this.queued) {
      node.onended = null; try { node.stop() } catch { /* Already stopped. */ }
      node.disconnect(); buffer.getChannelData(0).fill(0); node.buffer = null
    }
    this.queued.clear(); this.end = this.context.currentTime
  }
  async drain(): Promise<void> {
    const deadline = Date.now() + 1500
    while (this.queued.size && !this.closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    if (this.queued.size) await this.clear()
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true; this.qualified = false
    navigator.mediaDevices?.removeEventListener('devicechange', this.changed)
    await this.clear(); await this.context.close()
  }
}
