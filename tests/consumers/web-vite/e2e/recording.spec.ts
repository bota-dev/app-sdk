import { createDecipheriv, createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'

const projectId = 'proj_0123456789ABCDEFGHIJKLMN'

// Synthetic API/provider, real packaged WASM, microphone worklet, WebCrypto,
// IndexedDB, WebSocket framing and consuming App controls.
for (const interrupted of [false, true]) test(`recording consumer completes the independent original; live interrupted=${interrupted}`, async ({ page }) => {
  let admission: any, chunks = 0, samples = 0, ended = false, liveFrames = 0, changed = false, currentRevision = 1
  const key = Buffer.alloc(32, 7), hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
  const uuid = (value: string) => Buffer.from(value.replaceAll('-', ''), 'hex')
  await page.addInitScript(() => {
    navigator.storage.persist = async () => true
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext({ sampleRate: 48000 }), destination = context.createMediaStreamDestination(), tone = context.createOscillator()
      await context.resume(); tone.connect(destination); tone.start()
      const track = destination.stream.getAudioTracks()[0]!, stop = track.stop.bind(track)
      track.stop = () => { stop(); tone.stop(); void context.close() }
      return destination.stream
    }
  })
  await page.route('**/recording-host/*', async route => {
    const body = route.request().postDataJSON(), action = route.request().url().split('/').at(-1)
    let result: any = {}
    if (action === 'models') result = { revision: 'catalog-1', defaults: { asr: 'asr_deepgram_nova3', translation: 'mt_deepl', tts: 'tts_elevenlabs_flash25' }, models: [
      { id: 'mt_deepl', label: 'DeepL', stage: 'translation', available: false },
      { id: 'mt_amazon_translate', label: 'Amazon Translate', stage: 'translation', available: true } ] }
    else if (action === 'start') {
      admission = body
      result = { scope: JSON.stringify([projectId, 'eu_test']), clockId: body.clockId,
        activity: { id: body.activityId, expires_at: new Date(Date.now() + 60000).toISOString() },
        configuration: { projectId, activityId: body.activityId, endpoint: 'wss://api.example.invalid/v1/recording-speech/ws' },
        grant: { version: 1, project_id: projectId, activity_id: body.activityId, transport: 'websocket', protocol: 'bota.recording-speech.v1',
          url: 'wss://api.example.invalid/v1/recording-speech/ws', token: 'a'.repeat(43), generation: 1, expires_at: new Date(Date.now() + 20000).toISOString() },
        prepared: { protocol_version: 1, profile: 'speech_capture_pcm_v1', capture_id: body.captureId, recording_id: 'rec_browser', sample_rate: 48000,
          channels: 1, format: 'pcm_s16le', cipher: 'AES-256-GCM', data_key: key.toString('base64'), maximum_chunk_samples: 48000, upload_until: new Date(Date.now() + 60000).toISOString() } }
    } else if (action === 'capture_status') result = { state: 'open' }
    else if (action === 'capture_chunk') {
      const packet = body.packet, h = packet.header, numbers = Buffer.alloc(24)
      numbers.writeUInt32BE(h.sequence); numbers.writeBigUInt64BE(BigInt(h.firstSample), 4); numbers.writeUInt32BE(h.samples, 12); numbers.writeBigUInt64BE(BigInt(h.archiveSample), 16)
      const aad = Buffer.concat([Buffer.from('bota.speech.capture.chunk.v1\0'), uuid(body.captureId), uuid(h.clockId), numbers])
      expect(h.clockId).toBe(admission.clockId); expect(h.archiveSample).toBe(samples)
      chunks++; samples += h.samples
      result = { sequence: h.sequence, stored: true, sha256: hash(Buffer.concat([aad, Buffer.from(packet.nonce, 'base64'), Buffer.from(packet.ciphertext, 'base64')])) }
    } else if (action === 'capture_complete') {
      const packet = body.packet, ciphertext = Buffer.from(packet.ciphertext, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(packet.nonce, 'base64'))
      decipher.setAAD(Buffer.concat([Buffer.from('bota.speech.capture.manifest.v1\0'), uuid(body.captureId)])); decipher.setAuthTag(ciphertext.subarray(-16))
      const manifest = JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString())
      expect(manifest.archiveSamples).toBe(samples); expect(manifest.clocks[0].endKnown).toBe(true)
      result = { profile: 'speech_capture_pcm_v1', capture_id: body.captureId, recording_id: 'rec_browser', state: 'published', audio_verification: 'verified',
        manifest_sha256: hash(packet.nonce + '\0' + packet.ciphertext), content_sha256: 'b'.repeat(64), archive_samples: samples }
    } else if (action === 'capture_transcript') result = { state: 'completed', alignment: 'verified_original', result_sha256: 'c'.repeat(64), next_segment: 1, has_more: false,
      final_translation: 'completed', segments: [{ text: 'Verified original sentence.', translation_units: [{ targetLanguage: 'zh', revision: 1, state: 'completed', targetText: '最终译文。' }] }] }
    else if (action === 'end') ended = true
    await route.fulfill({ json: result })
  })
  await page.routeWebSocket('**/v1/recording-speech/ws', socket => {
    const send = (value: object) => socket.send(JSON.stringify(value))
    socket.onMessage(message => {
      if (typeof message !== 'string') {
        liveFrames++; expect(message.subarray(0, 4).toString()).toBe('BRS1')
        if (liveFrames === 1) expect(message.length).toBe(32 + 4800 * 2)
        if (liveFrames === 1) {
          send({ type: 'caption', activityId: admission.activityId, generation: 1, revision: currentRevision, final: true,
            caption: { unitId: `${admission.activityId}:1:${currentRevision}:microphone:1:1`, sourceId: 'microphone', sourceEpoch: 1, revision: currentRevision,
              startSample: 0, endSample: 960, sourceLanguage: 'multi', text: 'Live original sentence.' } })
          if (interrupted) socket.close()
        }
        return
      }
      const value = JSON.parse(message)
      if (value.type === 'authenticate') send({ type: 'ready', version: 1, activityId: admission.activityId, generation: 1, target: { revision: 1, language: 'zh' },
        sources: [{ id: 'microphone', epoch: 1, role: 'mixed', speaker: 'unknown', language: 'multi', startSample: 0, captureClockId: admission.clockId }],
        input: { format: 'pcm_s16le', sampleRate: 48000, maxFrameSamples: 4800 }, playbackRoute: 'unqualified' })
      if (value.type === 'target') { changed = true; currentRevision++; send({ type: 'target_committed', activityId: admission.activityId, generation: 1,
        requestId: value.change.requestId, target: { revision: currentRevision, language: value.change.language } }) }
      if (value.type === 'finish') send({ type: 'finished', activityId: admission.activityId, generation: 1 })
    })
  })
  await page.goto('/recording.html'); await page.locator('#code').fill('a'.repeat(40)); await page.locator('#load-models').click()
  await expect(page.locator('#status')).toContainText('Models loaded')
  await expect(page.locator('#translation-model option[value=mt_deepl]')).toHaveJSProperty('disabled', true)
  await page.locator('#translation-model').selectOption('mt_amazon_translate')
  await page.locator('#start').click()
  await expect.poll(() => admission?.modelCatalogRevision).toBe('catalog-1')
  expect(admission.models).toEqual({ translation: 'mt_amazon_translate' })
  await expect.poll(() => liveFrames).toBeGreaterThan(0)
  if (!interrupted) {
    await expect(page.locator('#captions')).toContainText('Live original sentence.')
    await page.locator('#target').selectOption('ja'); await page.locator('#change').click()
    await expect.poll(() => changed).toBe(true); await expect(page.locator('#status')).toContainText('acknowledged')
  }
  await expect.poll(() => chunks, { timeout: 10000 }).toBeGreaterThan(0)
  await page.locator('#finish').click()
  await expect(page.locator('#final')).toContainText('Verified original sentence.', { timeout: 10000 })
  await expect(page.locator('#final')).toContainText('最终译文。')
  expect(ended).toBe(true); expect(samples).toBeGreaterThan(0)
  await page.locator('#close').click(); await expect(page.locator('#status')).toHaveText('Closed.')
})

test('leaving during microphone permission retires the late input without sending audio', async ({ page }) => {
  let admission: any, frames = 0
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => {
      ;(window as any).releaseRecordingPermission = () => {
        const context = new AudioContext({ sampleRate: 48000 }), destination = context.createMediaStreamDestination()
        const track = destination.stream.getAudioTracks()[0]!, stop = track.stop.bind(track)
        track.stop = () => { stop(); (window as any).recordingInputStopped = true; void context.close() }
        resolve(destination.stream)
      }
    })
  })
  await page.route('**/recording-host/*', async route => {
    let result: object = {}
    if (route.request().url().endsWith('/start')) {
      admission = route.request().postDataJSON()
      const endpoint = 'wss://api.example.invalid/v1/recording-speech/ws'
      result = { scope: 'permission-test', clockId: admission.clockId, activity: { id: admission.activityId, expires_at: new Date(Date.now() + 60000).toISOString() },
        configuration: { projectId, activityId: admission.activityId, endpoint },
        grant: { version: 1, project_id: projectId, activity_id: admission.activityId, transport: 'websocket', protocol: 'bota.recording-speech.v1',
          url: endpoint, token: 'a'.repeat(43), generation: 1, expires_at: new Date(Date.now() + 20000).toISOString() } }
    }
    await route.fulfill({ json: result })
  })
  await page.routeWebSocket('**/v1/recording-speech/ws', socket => socket.onMessage(message => {
    if (typeof message !== 'string') { frames++; return }
    if (JSON.parse(message).type === 'authenticate') socket.send(JSON.stringify({ type: 'ready', version: 1, activityId: admission.activityId, generation: 1,
      target: { revision: 1, language: 'zh' }, sources: [{ id: 'microphone', epoch: 1, role: 'mixed', speaker: 'unknown', language: 'multi', startSample: 0, captureClockId: admission.clockId }],
      input: { format: 'pcm_s16le', sampleRate: 48000, maxFrameSamples: 4800 }, playbackRoute: 'unqualified' }))
  }))
  await page.goto('/recording.html'); await page.locator('#retention').selectOption('text_only'); await page.locator('#start').click()
  await page.waitForFunction(() => typeof (window as any).releaseRecordingPermission === 'function')
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); (window as any).releaseRecordingPermission() })
  await page.waitForFunction(() => (window as any).recordingInputStopped === true)
  await expect(page.locator('#start')).toBeEnabled(); expect(frames).toBe(0)
})
