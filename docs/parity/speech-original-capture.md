# Independent original capture

This is an unpublished Phase 3 source candidate. The five SDK families have
source integrations for one microphone feeding RTC and a separate encrypted
archive. Component checks do not qualify an end-to-end conversation, physical
audio, distribution, or deployment. The authoritative cross-repository completion
checklist remains in the internal Realtime Speech Design.

## Ownership and format

The host admits `original_audio_and_text` and `speech_capture_pcm_v1` before
capture. It creates a dedicated capture UUID and recording, scoped to the current
project, EndUser and member generation. Phone/browser capture never impersonates
a device recording. Backend migration 148 is required; BYO storage is excluded.

`protocol/manifest/speech-capture-v1.json` defines 48 kHz mono PCM16LE, one-second
maximum chunks, a two-hour sample limit and bounded clock/chunk counts. The
canonical encrypted fixture is `protocol/speech-session/capture-v1.json`.
Rust owns metadata validation, clock transitions, AAD, chain and receipt policy.
Native crypto and WebCrypto encrypt PCM outside the Rust ABI. The capture key
stays in Apple Keychain, Android Keystore or non-extractable WebCrypto storage.
Native journals and chunks use private, backup-excluded SQLite; Web uses
IndexedDB with strict transactions and exclusive Web Locks. New Web capture
requires persistent storage admission. Recovery may retry existing encrypted
data without receiving a new persistence grant.

The physical owner converts once, then gives the same canonical PCM to the
archive pump and the RTC input branch. Four pending native/Web chunks bound disk
backpressure. Dropped archive intervals preserve their actual sample positions;
they are never replaced by invented audio. Crash recovery seals the old clock
with an unknown tail. A new physical capture has a new clock identity.

RTC mute, disconnect and media close retire only the RTC branch. Explicit
original stop joins physical input and accepted disk writes, then seals the
manifest. Leaving/backgrounding joins both owners. Native capture and the RN
native media owner enforce the authenticated expiry without relying on a JS
timer. The host must supply microphone permission, audio routing and scope-correct
grant renewal; the reusable microphone owner does not change global audio focus
or the Apple audio-session category.

Android hosts using original capture must declare `RECORD_AUDIO` and obtain the
runtime grant. The base SDK does not add microphone permission to other consumers.
The capture owner checks permission again on its IO thread and maps revocation
during recorder creation to `UNAUTHORIZED`, retaining the recoverable archive.

## Public integration surfaces

| Family | Source entry and owner | Independent original control |
| --- | --- | --- |
| Web | `/speech/capture`: `createWebSpeechCapture`, `recoverWebSpeechCapture`, scoped enumeration; `/speech/capture-input`: the microphone graph | Stop the physical graph and seal the archive separately from the RTC port; retry upload from durable storage. |
| Apple | `SpeechCaptureArchive`, `SpeechCapturePump`, `SpeechMicrophoneCapture`, `SpeechCapturePolicy` | `stop` or `interruptAndStop`, then archive `finish`, `flush` and joined `close`. The optional `ExternalPCMInput` receives the same PCM. |
| Android | The corresponding public classes in `dev.bota.sdk.speech` | `stop` or `interruptAndStop`, then archive `finish`, `flush` and `close`; feed the optional `ExternalPcmInput` from the same source. |
| Flutter | `setSpeechConnectionFactory` installs a native `BotaFlutterSpeechConnection`; Dart remains a typed Pigeon facade | `session.originalView()` and `session.finishOriginal()` remain available after RTC failure. Native connection close joins original and RTC ownership. |
| React Native | `/speech/native-media`: `createNativeSpeechMedia` consumes a host-supplied `NativeSpeechMediaIO` | The App retains the native original owner independently, exposes bounded display metadata and explicit stop, and joins it on departure. Session decisions still execute in generated Rust JavaScript. |

The native companions' `LabOriginal` coordinators and Web's `speechOriginal.ts`
show scoped preparation, recovery, upload, source binding and final-text polling.
Flutter and RN consume those same native capture/archive implementations. The RN
companion uses the native Swift/Kotlin LiveKit adapters, avoiding a second JS
WebRTC microphone/runtime in that App. The existing `/speech/livekit` adapter
remains available for applications that supply the RN vendor stack themselves.

`NativeSpeechMediaIO.mediaFence` must execute synchronously and fence late
acquisitions. `closeMedia` joins submitted RTC IO and retires callbacks; it must
not delete or stop the independently owned original. The example native bridge
bounds event delivery and closes media on overflow, background, invalidation or
authorization expiry. No PCM, encrypted part, capture key or archive retry cursor
enters Flutter/RN display messages.

## Publication and text

Upload retries retain immutable ciphertext. Local deletion requires a published,
verified receipt matching the exact capture, recording, encrypted manifest digest
and sample count, with a valid original-content digest. A transaction records the
receipt tombstone and removes local ciphertext; key deletion follows. Recovery
finishes key cleanup after a crash. A completed capture ID cannot be reused.
Late network responses cannot update a retired local owner.

The backend verifies/decrypts chunks, reconstructs the original WAV, publishes its
digest and commits the existing transcription outbox atomically with the receipt.
Archive completion is independent of RTC termination. Binding can complete after
publication but still requires the exact source owner, capture lifetime and
current worker generation. Generic recording upload contracts cannot complete
this profile.

Final text is independently transcribed from the verified original file and
mapped through authenticated capture offsets. Paginated results pin a result
digest and expose `captureIntervals`, discontinuities and unknown clock ends.
Live captions remain provisional. There is no exact RTP-to-capture clock claim.
Editing the transcript removes its original-input proof. Empty captures return
`no_audio`; a completed silent transcription can contain zero segments. The
companions show bounded final-text previews; authoritative pagination remains
available on the backend capture transcript endpoint. If provider admission cannot schedule ASR, the endpoint reports unavailable text; clients preserve the verified original and display that state separately from pending transcription.

## Design review and remaining qualification

| Requirement | Source evidence | Conformance and remaining work |
| --- | --- | --- |
| One original source, independent branches | Native microphone conversion/fork and Web AudioWorklet graph; native encrypted PCM equality checks | Source implementation; physical route, AEC, interruptions and device timing require qualification. |
| Durable encrypted retry and exact deletion | Real SQLite/WebCrypto journals, canonical AES fixtures, packaged browser AudioWorklet/IndexedDB recovery, mismatched-receipt and late-HTTP checks | Component behavior checked; process-kill, storage pressure and actual secure-store/device acceptance remain. |
| Capture timeline and final text | Shared Rust clock policy; backend migration/store/service; canonical ciphertext through real PostgreSQL publication and sample mapping | Original-file reprocessing policy implemented; actual provider output and full application presentation require end-to-end validation. |
| Five SDK families | Public source entries and consuming companions for Web, Apple, Android, Flutter and RN | Generated JS, Pigeon and native API contracts are synchronized. Local native/JS/Dart consumers and the packaged browser path are checked; final-source hosted builds and physical device qualification are separate gates. |
| Distinct capture, RTC and publication outcomes | Independent original controls, native expiry fencing, source finish, bounded final-text polling, unavailable-ASR state and explicit gaps | Component checks do not establish G1–G6 completion. No cohort or release is enabled by this change. |

The compound-engineering skill was unavailable, so this review directly compares
the implementation with RTC-O04 / RTC-X01 / G4 and five-family ownership
requirements. Final-source hosted builds must include complete Xcode/iOS consumers.
Real microphones and audio routes, two-person
RTC/ASR/translation/TTS, long-duration/concurrency behavior and optional vendor
redistribution approval remain separate checks. Local composed regression covers the completed source and generated contracts; it does not complete the physical/provider/release gates in the single cross-repository checklist.
