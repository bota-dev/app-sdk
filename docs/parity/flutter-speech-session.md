# Flutter speech session ownership

Status: unpublished Phase 3 source candidate for Flutter iOS 15+ and Android
API 26+. The Dart API and native plugin bridges are implemented; actual
Flutter/media/backend integration and package/device qualification remain open.
This does not add Flutter Web or desktop support, publish a package, or enable
the backend feature. The single end-to-end checklist remains in the internal
Realtime Speech Design, under Phase 3 evidence and unresolved release choices.

## Integration contract

`BotaSpeechClient()` returns the same client in the engine's Dart isolate, even
after terminal destruction. Repeated construction cannot replace its event
handler or create a second lifecycle owner. Use `close` to replace a session;
reserve `destroy` for retiring the engine's speech client. The explicit
`forTesting` constructor supplies an isolated host/channel seam for tests only.
The client owns one active speech session at a time, independently of
`BotaDeviceClient` and Bluetooth workflows.
The native App installs `BotaFlutterSdkPlugin.setSpeechFactory` before the first
speech session. The factory receives the requested backend session ID and the
bridge observer, and must promptly return a fresh native `SpeechSession` using
that observer. It must resolve that exact ID under current host authentication;
the ID supplied by Dart is not authorization.

Prepare the initial configuration and short-lived participant grant in native
host code before calling Dart `start`. Do not block the factory with HTTP work.
Supply the ordinary native `SpeechHostCallbacks` for subscription changes,
renewal, recovery and source finish, plus the selected native media factory.
No project/provider key belongs in the SDK. Native factories must clean up
resources they allocate if they throw before returning a session. Missing host
integration fails with `unavailable`; there is no default backend or microphone
capture. Initial permission and audio-route ownership remain host responsibilities.

The existing native contracts apply unchanged:
[Apple](apple-speech-session.md) and [Android](android-speech-session.md).
The optional LiveKit modules currently provide microphone candidates. Authorized
external capture and simultaneous archival still need their native adapters;
adding a Flutter control does not implement those media paths.

```dart
final speech = BotaSpeechClient();
final session = await speech.start(
  authorizedSessionId,
  observer: BotaSpeechObserver(
    onCaption: renderCaption,
    onState: renderSpeechState,
    onError: showSpeechError,
  ),
);
try {
  await session.setListening(true);
  await session.setInput(true);
  // Input and listening are independent. Subscription application still needs
  // both native Rust authorization and actual playback-buffer clearing.
  await session.changeSubscription(const BotaSpeechSelection(
    targetLanguage: 'ja',
    mode: BotaSpeechListeningMode.translated,
    sourceParticipantIds: [],
  ));
  final finish = await session.finishInput();
  showSourceFinish(finish); // Inspect completed/interrupted/unavailable status.
} finally {
  await speech.destroy();
}
```

The rendering functions and authenticated session ID above belong to the App.
`resumeAudio` delegates to the native player; `recoverCaptions` returns the native
recovery status. `state` is the last native snapshot, while `isClosed` reports
retired Dart ownership. Read the full source-finish status instead of interpreting
a successful method return as a verified archive or a complete ASR tail.

## Boundaries and lifecycle

- Pigeon carries typed controls, content-free state, source-finish metadata and
  validated captions. It carries no PCM, RTC objects, grants, credentials,
  recovery cursors, host requests or unfiltered protocol JSON. Unsigned source
  epochs/sequences use decimal strings to preserve their complete value range.
- Rust remains the only speech policy owner. Swift/Kotlin delegate to the native
  facades; Dart maps their values. Capture/listening, language revisions,
  source-finish holds and recovery are not reimplemented as Flutter reducers.
- Each native owner allows 32 admitted control calls and 32 queued observer
  messages plus one acknowledged delivery. A missing Dart reply has a five-second
  deadline. Overflow or channel failure closes media and attempts one neutral
  terminal notification; delivery to a departed engine is not guaranteed.
- Observer callbacks are synchronous and short. Dart does not expose a buffered
  speech stream. Upsert captions by key, preserve finals, and do not log private
  text. A throwing App callback retires the session. Arbitrary native/App error
  messages and details never enter the public error object.
- Close retires events before awaiting native cleanup and admitted calls.
  Engine detach unregisters the channels and synchronously retires its native
  owner. Cleanup proceeds independently of a cancelled waiter, and does not
  wait for Dart to acknowledge an obsolete event. Native `speechShutdown`
  exposes the plugin's cleanup task/deferred for host inspection.
- Cleanup failures remain stable and prevent owner reuse. A failed native owner
  remains retained; do not infer released audio ownership from a closed channel.
  `destroy` is terminal and idempotent. Closing an old session cannot close its
  replacement. Explicitly destroy the speech client even when separately
  destroying the Bluetooth client.

## Verification and conformance

| Requirement | Source evidence | Remaining acceptance |
| --- | --- | --- |
| RTC-M04 / G3: Flutter native ownership, no audio over Pigeon | Generated typed channels, native `SpeechSession` wrappers, unchanged Rust/native media ownership | Actual iOS/Android Flutter App with the selected native media adapter |
| RTC-O03 / RTC-M02–03: independent controls and languages | Dart channel round-trip and native delegate checks | Real concurrent capture/playback and personalized receiving languages |
| RTC-X02–03: retirement, source finish and recovery | Correlation fencing, joined close, stable failure, typed finish/recovery, dropped late callbacks | Actual backend authority, RTP tails, expiry/revocation and network recovery |
| RTC-X03: bounded queues and cancellation | Slow-Dart overflow, cancelled waiter, synchronous factory overflow and late/duplicate reply regressions | Physical lifecycle, route changes, prolonged degraded links |
| RTC-X01 / G4: retention and data truth | No bridge audio or implicit storage; private text uses explicit callbacks | Original archival, clocks/gaps, all retention modes and verified reconciliation |
| G6: synchronized delivery | Source metadata, Pigeon drift and component tests | Final-source CI, immutable packages, consuming Apps and physical media qualification |

The local candidate passes all 94 Dart checks (including seven speech checks),
static analysis and Pigeon drift verification, plus all 31 Flutter Android
adapter checks (including eight speech checks). Seven shared Swift speech checks
compile the complete shipping Apple facade and Flutter plugin against the actual
Rust library using `bash tools/speech/test-flutter-apple-host.sh`. The normal
Xcode adapter suite discovers those same checks through XCTest.
The normal Flutter consumer gate now runs both native adapter suites against
the exact fresh XCFramework/AAR built in that invocation, before building the
ordinary iOS/Android Apps. It does not rebuild or substitute a published native
package for those source checks. The Android guard uses runner-provided `grep`;
an actual adapter-script run with no `rg` on `PATH` reproduces the preceding
failure and passes after the correction, retaining the version-mismatch refusal.
SwiftPM-only checks do not require CocoaPods: the CocoaPods/Ruby guard applies
when the helper proceeds to its separate application consumers. CI run
`41450687512` exposed the previous premature guard before XCTest could start.
Successor run `41454045309` passes all 42 Apple adapter XCTest checks, including
the seven speech checks, the Android adapter checks, and the iOS release App
build. Its Android release App then rejects a redundant `Unit` expression under
the generated host's Kotlin 2.4 compiler with warnings-as-errors. The source
correction removes that expression, retaining both warnings-as-errors and the
standalone Kotlin 2.1.20 check. Complete final-source CI remains required.

The CI-only `release/candidates/2.0.0-beta.23.json` inventory is generated from
the 67 committed package files with pinned Node.js 22.23.2 and the canonical
archive/manifest tools. Local archive readback verifies every file hash. The
historical release example and other platform artifacts remain unchanged;
the full hosted consumer gate must reproduce this candidate before acceptance.

Existing Pigeon device-message type tags remain unchanged. The speech mode uses
a validated string inside its new DTO and maps to native/Dart enums, avoiding
the codec renumbering that adding a Pigeon enum would cause. A fixed legacy-wire
regression protects this compatibility boundary. Android lint retains the
qualified Flutter AGP pin and excludes only its upgrade recommendation alongside
the existing newer-version advisory; correctness checks remain enabled.

The generated-channel regression also constructs the public client twice while
a session is active, verifies caption delivery to the original observer, and
rejects reconstruction after terminal destruction. It fails against the prior
constructor, which replaced the active engine callback handler.

The host helper substitutes only Flutter's platform-channel API for compilation;
it does not emulate an actual Flutter engine or device. The generated Pigeon
Swift 5 code retains the existing compiler warnings under newer Command Line
Tools; changed speech/plugin sources and test callers introduce none. The normal
CI still compiles the actual iOS plugin and fresh platform consumers. Local
checks do not establish package installation, real RTC audio, AEC/double-talk,
background/Bluetooth routing, original-archive correctness or G3/G6 completion.
