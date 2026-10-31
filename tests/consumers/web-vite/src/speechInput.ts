import { createLiveKitWebMedia } from '@bota.dev/web-app-sdk/speech/livekit'

/** Actual browser track ownership with an inert RTC boundary: no microphone,
 * provider, room token or network media is used by this consumer check. */
export async function verifyExternalSpeechInput() {
  const context = new AudioContext()
  await context.resume()
  const oscillator = context.createOscillator(), destination = context.createMediaStreamDestination()
  oscillator.connect(destination); oscillator.start()
  const original = destination.stream.getAudioTracks()[0]!
  let branch: MediaStreamTrack | undefined, publishes = 0, disconnects = 0
  const analyser = context.createAnalyser(), silent = context.createGain()
  silent.gain.value = 0; analyser.connect(silent); silent.connect(context.destination)
  const samples = new Float32Array(analyser.fftSize)
  async function hasSignal(expected: boolean) {
    const until = performance.now() + 3_000
    while (performance.now() < until) {
      analyser.getFloatTimeDomainData(samples)
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
      if (expected ? rms > 0.01 : rms < 0.0001) return true
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return false
  }
  const room = {
    name: 'synthetic-room', remoteParticipants: new Map(),
    localParticipant: { identity: 'synthetic-member', async publishTrack() { publishes++; return { trackSid: 'TR_branch' } },
      async unpublishTrack() {} },
    on() {}, off() {}, async connect() {}, async disconnect() { disconnects++ }, async startAudio() {},
    registerTextStreamHandler() {}, unregisterTextStreamHandler() {},
  }
  const signal = new AbortController().signal
  const port = createLiveKitWebMedia({ text() {}, trackRemoved() {}, disconnected() {}, failed() {}, playbackBlocked() {} }, {
    roomFactory: () => room, silenceVendorLogs() {},
    externalInput: { participantId: 'synthetic-participant', memberGeneration: 1, track: original,
      wrapTrack(track) {
        branch = track; context.createMediaStreamSource(new MediaStream([track])).connect(analyser)
        return { mediaStreamTrack: track, stop: () => track.stop() }
      } },
  })
  try {
    await port.connect({ protocol_version: 1, provider: 'livekit', url: 'wss://unused.livekit.cloud', token: 'synthetic',
      room: room.name, identity: room.localParticipant.identity, processor_identity: 'synthetic-worker',
      expires_at: '2030-01-01T00:00:00Z', session_id: 'synthetic-session', participant_id: 'synthetic-participant',
      member_generation: 1, worker_generation: 1 }, signal)
    await port.setMicrophone(true, signal)
    if (!branch) throw Error('missing owned branch')
    const separate = branch !== original && branch.id !== original.id
    if (!await hasSignal(true)) throw Error('synthetic input did not reach owned branch')
    original.enabled = false
    const hostMuteRespected = await hasSignal(false)
    original.enabled = true
    const hostUnmuteRespected = await hasSignal(true)
    port.holdMicrophone!()
    const held = !branch.enabled && original.enabled && original.readyState === 'live'
    const publication = port.microphonePublication!()
    await port.setMicrophone(false, signal)
    const retired = String(branch.readyState) === 'ended' && original.readyState === 'live' && original.enabled && disconnects === 0
    await port.close()
    return { separate, held, publication, retired, publishes, disconnects, hostMuteRespected, hostUnmuteRespected,
      hostStillLive: original.readyState === 'live' && original.enabled }
  } finally {
    await port.close(); original.stop(); oscillator.stop(); await context.close()
  }
}
