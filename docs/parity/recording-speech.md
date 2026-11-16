# Recording-owned realtime speech (source preview)

The current protocol is one end-user/device activity, one target language and
one qualified downlink. It uses an authenticated WebSocket for continuous upload
and downlink, optional independent encrypted original capture, and no room or participant roster. This
source preview is default-off and is not a published SDK feature.

## Server admission and stage controls

The backend requires its `RECORDING_SPEECH_ENABLED` master switch and an exact
project ID in `RECORDING_SPEECH_PROJECT_IDS`; an empty whitelist admits nobody.
Its separate `RECORDING_SPEECH_ASR_ENABLED`, `RECORDING_SPEECH_TTS_ENABLED` and
`RECORDING_SPEECH_DOWNLINK_ENABLED` flags also default to `false`.

- ASR off permits capture and encrypted upload, with no realtime ASR, translation
  or TTS. New upload-only activities have null provider bindings and no final MT.
- TTS off permits enabled source/translated captions without synthesized audio.
- Downlink off blocks generated-audio delivery even after headphone confirmation.
  Captions continue when ASR is enabled; synthesis without an output consumer is
  skipped. Effective TTS therefore requires ASR, TTS and downlink all enabled.

These are server process settings applied by deployment, not client permissions,
Portal controls or hot session toggles. Client route/target messages cannot
override them. The DEV deployment JSON uses `asrEnabled`, `ttsEnabled` and
`downlinkEnabled`, defaulting to `false`, alongside the master `enabled` and
`projectIds`. Only selected provider dependencies require credentials: upload-only
needs no realtime providers; captions-only needs Deepgram and DeepL; effective
speech additionally needs ElevenLabs. The current preview refuses HIPAA/GDPR
projects and BYO provider routes.

## Integrate the direct owner

The authenticated application backend resolves the end user, prepares a capture
only for `original_audio_and_text`, creates the activity with the same physical
capture clock, and issues its single-use grant. Keep project credentials on that
backend. The microphone source is `mixed`/`unknown`, starts at sample zero, and
uses PCM16 mono at 48 kHz. Output is memory-only PCM16 mono at 24 kHz.

The backend first stores ordered encrypted input objects and commits their upload
receipts, then continuously reads and verifies them into enabled ASR. The existing `BRS1`
frames and source/target clocks are unchanged. Translation, TTS and playback can
start while capture is still running; no complete file or stop event is required.
All retention modes use temporary encrypted uploaded input, with a key confined
to the active connection and asynchronous object cleanup. This does not create
a permanent original recording in text/live-only mode. Storage failure interrupts
live processing rather than bypassing storage. The optional original capture's
publication receipt remains separate from the temporary input's stored receipt.

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
Retained-original batch ASR remains separate from the realtime ASR switch.
Existing activities with a pinned translation route can finish final MT after
live ASR is disabled only while the original DeepL credential/revision/plan and
master/project admission remain available. An operator retaining this path keeps
`deeplCredentialRevision` and `deeplPlan` together with `DEEPL_API_KEY`; new
upload-only activities do not acquire a translation binding implicitly.

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
For a selected USB Android device, forward the same port with
`adb -s SERIAL reverse tcp:4173 tcp:4173`. macOS and an iOS Simulator on that host
can use its loopback directly. A physical iOS device requires an approved local
transport or the production authenticated host integration; this lab does not
listen on the LAN or expose project credentials to bypass that limitation.
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
