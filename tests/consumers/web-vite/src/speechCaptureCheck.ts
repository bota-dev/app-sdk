import { createWebSpeechCapture, recoverWebSpeechCapture, listWebSpeechCaptures, listWebSpeechCaptureReceipts,
  type SpeechCaptureChunk } from '@bota.dev/web-app-sdk/speech/capture'
import { createWebSpeechCaptureInput } from '@bota.dev/web-app-sdk/speech/capture-input'

/** Real browser worklet, WebCrypto, IndexedDB and recovery. Only microphone
 * acquisition, persistent-storage admission and the remote receipt are synthetic. */
export async function verifySpeechCapture() {
  const scope = `browser-capture-${crypto.randomUUID()}`, captureId = crypto.randomUUID(), recordingId = 'rec_browser_capture'
  const raw = new Uint8Array(32).fill(7), encode = new TextEncoder()
  const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  const decode = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0))
  const uuid = (value: string) => Uint8Array.from(value.replaceAll('-', '').match(/../g)!, byte => parseInt(byte, 16))
  const concat = (...parts: Uint8Array[]) => {
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0
    for (const part of parts) { bytes.set(part, offset); offset += part.length }; return bytes
  }
  const hash = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), byte => byte.toString(16).padStart(2, '0')).join('')
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
  const source = new AudioContext({ sampleRate: 48000 }); await source.resume()
  const tone = source.createOscillator(), destination = source.createMediaStreamDestination()
  tone.connect(destination); tone.start()
  const realMicrophone = navigator.mediaDevices.getUserMedia, realPersist = navigator.storage.persist
  let acquisitions = 0, archive: Awaited<ReturnType<typeof createWebSpeechCapture>> | undefined
  let input: Awaited<ReturnType<typeof createWebSpeechCaptureInput>> | undefined
  const errors: string[] = []
  navigator.mediaDevices.getUserMedia = async () => { acquisitions++; return destination.stream }
  navigator.storage.persist = async () => true
  try {
    archive = await createWebSpeechCapture({ scope, prepared: { protocol_version: 1, profile: 'speech_capture_pcm_v1',
      capture_id: captureId, recording_id: recordingId, sample_rate: 48000, channels: 1, format: 'pcm_s16le', cipher: 'AES-256-GCM',
      data_key: base64(raw), maximum_chunk_samples: 48000, upload_until: new Date(Date.now() + 60000).toISOString() } })
    input = await createWebSpeechCaptureInput({ archive, onError: code => errors.push(code) }); await input.start()
    // Retiring an RTC-owned clone must leave the independent original running.
    const rtcBranch = input.track.clone(); rtcBranch.stop()
    await new Promise(resolve => setTimeout(resolve, 1200))
    const independent = input.capturing && input.track.readyState === 'live'
    await input.finish(); await input.close()
    const samples = archive.snapshot.archiveSamples
    await archive.close(); archive = await recoverWebSpeechCapture({ scope, captureId })
    let verifiedSamples = 0, nonzero = false, sealed = false
    await archive.flush({
      async status() { return { state: 'open' } },
      async upload(packet: SpeechCaptureChunk) {
        const header = packet.header, numbers = new Uint8Array(24), view = new DataView(numbers.buffer)
        view.setUint32(0, header.sequence); view.setBigUint64(4, BigInt(header.firstSample)); view.setUint32(12, header.samples); view.setBigUint64(16, BigInt(header.archiveSample))
        const aad = concat(encode.encode('bota.speech.capture.chunk.v1\0'), uuid(captureId), uuid(header.clockId), numbers)
        const pcm = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(packet.nonce), additionalData: aad }, key, decode(packet.ciphertext)))
        if (pcm.length !== header.samples * 2 || header.archiveSample !== verifiedSamples) throw Error('capture_order')
        verifiedSamples += header.samples; nonzero ||= pcm.some(value => value !== 0)
        return { sequence: header.sequence, stored: true, sha256: await hash(concat(aad, decode(packet.nonce), decode(packet.ciphertext))) }
      },
      async complete(packet) {
        const aad = concat(encode.encode('bota.speech.capture.manifest.v1\0'), uuid(captureId))
        const manifest = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(packet.nonce), additionalData: aad }, key, decode(packet.ciphertext))))
        sealed = manifest.archiveSamples === samples && manifest.clocks.length === 1 && manifest.clocks[0].endKnown === true
        return { profile: 'speech_capture_pcm_v1', capture_id: captureId, recording_id: recordingId,
          state: 'published', audio_verification: 'verified', manifest_sha256: await hash(encode.encode(packet.nonce + '\0' + packet.ciphertext)),
          content_sha256: 'b'.repeat(64), archive_samples: samples }
      },
    }, new AbortController().signal)
    await archive.close()
    return { acquisitions, independent, audio: samples > 0 && verifiedSamples === samples && nonzero, sealed,
      deleted: (await listWebSpeechCaptures(scope)).length === 0,
      receipt: (await listWebSpeechCaptureReceipts(scope)).length === 1, errors }
  } finally {
    await input?.close(); await archive?.close()
    tone.stop(); await source.close()
    navigator.mediaDevices.getUserMedia = realMicrophone; navigator.storage.persist = realPersist
  }
}
