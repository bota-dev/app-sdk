import { Room, LocalAudioTrack, createLocalAudioTrack, setLogLevel, LogLevel } from 'livekit-client'
import { createLiveKitWebMedia } from '@bota.dev/web-app-sdk/speech/livekit'
import { mountSpeechApp } from './speechApp.ts'

// Keep the vendor's JavaScript factories outside the strict application type surface.
// Bota checks this public runtime boundary before opening the room or microphone.
mountSpeechApp(document.querySelector('#app'), callbacks => createLiveKitWebMedia(callbacks, {
  roomFactory: options => new Room(options),
  createMicrophone: options => createLocalAudioTrack(options),
  silenceVendorLogs: () => setLogLevel(LogLevel.silent),
}), (callbacks, track, member) => createLiveKitWebMedia(callbacks, {
  roomFactory: options => new Room(options),
  originalMicrophone: { ...member, track, wrapTrack: branch => new LocalAudioTrack(branch, undefined, true) },
  silenceVendorLogs: () => setLogLevel(LogLevel.silent),
}))
