# Legacy speech usage and runtime cleanup

## Scope and authority

The current product uses the [recording-owned protocol](recording-speech.md):
capture, committed uploaded segments, continuous ASR, translation, optional TTS
and downlink. The unpublished room preview is not this product contract.
This change removes unused React Native paths without changing backend gates,
project admission, provider configuration or deployed room resources.

## Source usage audit

| Area | Observed callers | Decision |
| --- | --- | --- |
| RN room policy and `/speech`, `/speech/native-media`, `/speech/livekit` | Old conversation controller, media adapters and their tests; the registered App already loads `RecordingApp` | Remove these unpublished exports, owners and retired tests. |
| JS RPC `speechSession` | Removed RN room adapter and its tests | Remove the binding and per-engine session registry. |
| JS RPC `speechCapture` | Generated-JS parity test only | Remove the duplicate JS entry; retain canonical capture tests and real native/Web owners. |
| JS RPC `recordingSpeech` | No production RN caller; `createRecordingSpeechClient` sends bounded controls to `NativeRecordingSpeechIO` | Remove the duplicate JS entry; preserve native and WASM implementations. |
| RN native room hosts and `ReactNativeLabOwner` | Removed JS conversation controller and dedicated compatibility tests | Remove the room bridge and owners. Keep a permission-only module and direct recording bridge. |
| RN consuming App LiveKit dependencies | Old media/archive bridge | Remove Android vendor/AAR dependencies, the Apple LiveKit package and copied room sources. Shared original display metadata moves to the existing transport support file. |
| Web WASM `WebSpeechClient`, room host and LiveKit entry | Separate Web room samples and their browser compatibility tests | Retained as an explicit legacy integration; not reachable through RN generated JS. |
| Rust room core, native FFI/JNI, Swift/Kotlin `SpeechSession`, Flutter adapter | Native/Flutter compatibility surfaces and dedicated conformance consumers | Retained. Retiring these exported surfaces and all dependent native consumers is separate from removing unused RN code. Shared capture/storage/clock capabilities remain required by direct recording. |
| Backend rooms/provider journals | Runtime use is not established by SDK source searches | No backend cleanup or environment changes. Drain/cleanup evidence remains required. |

The audit covers this branch and its checked-in consumers; it does not prove the
absence of external unpublished consumers. Published main has none of the removed
speech-preview entries. New integrations use `/speech/recording`.

## Design review and qualification

The compound-engineering skill is unavailable in the installed skill catalog;
the required design comparison is recorded here directly.

| Requirement | Implementation evidence | Verification boundary |
| --- | --- | --- |
| One native policy owner for RN recording | `recordingSpeech.ts` delegates to `NativeRecordingSpeechIO`; native and WASM exports remain | Existing direct-bridge lifecycle/admission regressions and platform builds are required. |
| No unused speech policies in generated JS | Three speech codec dispatches and the room registry removed | Three new native RPC tests fail on the old implementation and pass after cleanup; exact canonical Linux regeneration is required. |
| Preserve original capture, upload and playback semantics | Core, native recording/capture implementations and Web exports unchanged | Existing protocol/native/Web tests remain; no physical/provider acceptance is claimed. |
| Keep all feature gates closed | This change touches no server configuration or whitelist | Source defaults and deployment selection remain unchanged; this is not a live environment readback. |
| Complete security analysis | Existing CodeQL and Semgrep configuration retained | Exact-source full build and CodeQL must finish before reporting qualification. |

Baseline generated source at `2f7a2a05` is 5,804,332 bytes (gzip 1,134,901).
Canonical Linux preparation [44009980418](https://github.com/bota-dev/app-sdk/actions/runs/44009980418)
rebuilt the same source twice and produced 4,621,289 bytes (gzip 945,418):
1,183,043 fewer source bytes, a 20.38% reduction. The artifact archive digest,
producer revision and file digest were checked before adoption; current-source
provenance also passes. Core SHA-256 is
`2d65a4422164d185ff0082628be2c339681b4945b525a896f83603883fba0111`.
The intervening main merge changes only firmware documentation/changelog;
generator inputs remain identical. Local verification passes: 738 RN tests plus package/types/Codegen/licenses,
182 native-Rust/generated-JS differential cases, all 79 JS-bridge Rust tests,
13 direct recording/capture Rust tests, companion type checking and prepared
Android/iOS source/dependency checks. Repository tooling passed 125 cases on the
first run; its Cargo fingerprint test lacked Cargo on PATH, and all five cases
in that file passed with the pinned toolchain. Full hosted CI and CodeQL are
still pending at this checkpoint.
Source size is not installed App size or measured runtime heap usage.
