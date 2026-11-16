# Recording-owned realtime speech (source preview)

The current protocol is one end-user/device activity, one target language and
one qualified downlink. It uses a direct authenticated WebSocket, independent
optional encrypted original capture, and no room or participant roster. This
source preview is default-off and is not a published SDK feature.

## Integrate the direct owner

The authenticated application backend resolves the end user, prepares a capture
only for `original_audio_and_text`, creates the activity with the same physical
capture clock, and issues its single-use grant. Keep project credentials on that
backend. The microphone source is `mixed`/`unknown`, starts at sample zero, and
uses PCM16 mono at 48 kHz. Output is memory-only PCM16 mono at 24 kHz.

| Family | Direct controls | Capture/archive owner |
| --- | --- | --- |
| Apple | `RecordingSpeechSession`, `RecordingSpeechConnection` | `RecordingSpeechMicrophoneSession`, `SpeechCaptureArchive` |
| Android | Equivalent `dev.bota.sdk.speech` classes | Native microphone and encrypted journal |
| Web | `createWebRecordingSpeech`, `WebRecordingSpeechPlayback` from `/speech/recording` | `/speech/capture` and `/speech/capture-input` |
| React Native | `createRecordingSpeechClient` from `/speech/recording` | Host `NativeRecordingSpeechIO` implemented with the Swift/Kotlin owner |
| Flutter | `BotaRecordingSpeechClient` | Native `setRecordingSpeechFactory`; bounded typed Pigeon controls/text |

Native PCM, grants, archive keys and upload retry state never cross RN/Dart.
Web forks the same AudioWorklet samples into live transport and the original
journal. A failed live connection does not stop the physical input or archive.
Changing target language uses sample barriers and clear acknowledgement. Earlier
text retains its original target revision, while stale output is rejected.

`finish` stops capture, seals the original and drains live processing. The host
must end an interrupted activity too, so canonical final processing can run.
Keep the original owner open to flush retained ciphertext and read final text.
`close` joins input, transport, playback and upload cleanup; background/permission
races must retire a late-created owner. `RecordingSpeechCleanupFailure` is
terminal for that owner, not permission to open a fallback microphone.

Only an exact verified publication receipt permits local ciphertext deletion.
Page final text with its `result_sha256`; invalidate the old display on a changed
source version. Final translation follows historical target intervals and never
produces TTS. A retained original can complete after live failure. Text-only and
live-only activities have no retained audio or original-file final transcript.

## Maintained microphone consumers

The default native, RN and Flutter speech companions now use `RecordingLabOwner`.
Web uses `tests/consumers/web-vite/recording.html`. The older conversation samples
remain for gated legacy compatibility tests; they are not the current product
model. To serve the already-built Web consumer, supply these server-only settings:

- `BOTA_SPEECH_API_ORIGIN`: the enabled HTTPS API origin (WSS is required).
- `BOTA_SPEECH_API_KEY`: project credential with recording-speech/capture access.
- `BOTA_SPEECH_PROJECT_ID`, `BOTA_SPEECH_END_USER_ID`: one fixed lab owner.
- `BOTA_SPEECH_CODE`: an independently generated 32–128 character operator code.

Run `node --env-file=/absolute/private/lab.env tools/web/serve-speech.mjs`. This
binds only `127.0.0.1`; use the resulting host/code in the native companions.
The lab forwards controls and archive packets, and never returns its project key.
It does not replace a production login/authorization service. Failed or uncertain
activity creation cannot authorize later grant/end calls for that ID.

Apps expose all three retention modes, provisional paired captions, target
changes, explicit headphone qualification, stop/close and bounded final-text
previews. The examples refuse speaker playback. Route loss clears output; valid
capture/captions continue. Physical headphone detection, AEC/double-talk, external
stereo resampling/drift and Bota firmware clocks still need qualification.

## Evidence and delivery boundary

Rust owns the recording protocol and stereo manifest policies. RN's generated
core is regenerated on the canonical Rust 1.98 x86_64 Linux toolchain after main
integration. Web executes the packaged WASM; native hosts execute Rust/JNI/FFI.
Local consumer builds and synthetic provider/browser tests establish source
composition only. Complete Xcode/iOS artifacts and their source-bound checksums,
real providers, hardware, route/long-duration/concurrency/latency evidence and
protected publication remain separate gates. The single delivery checklist is
[Realtime Speech Design](https://github.com/bota-dev/internal-docs/blob/feat/realtime-translation/Realtime%20Speech%20Design.md#phase-3-evidence-and-unresolved-release-choices).
