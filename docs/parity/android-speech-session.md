# Android speech session orchestration

Status: unreleased Phase 3 source preview. The first delivery still includes
Apple, Android, Flutter, React Native and Web. The optional Android LiveKit
microphone adapter now connects this facade to native media in source. External
host input, Flutter integration, application adoption and the Phase 3
qualification gates remain incomplete.

## Requirement and ownership

An Android host must be able to publish original speech while independently
listening to its selected language, receive caption upserts, change its language,
recover retained captions and finish an input without closing the listening
session. Closing or abandoning an operation must not leave an audible or
capturing owner behind.

`dev.bota.sdk.speech.SpeechSession` executes the existing Rust `SpeechClient`
through `NativeSpeechPolicy`. Rust remains the only authority for participant
and worker generations, source identity, subscription revisions, permitted
tracks, expiry, caption cursors/upserts and source-finish state. Kotlin projects
typed metadata and executes platform/network effects. It does not reconstruct
an authorization or transcript reducer.

| Owner | Responsibility |
| --- | --- |
| Host application/backend | Authenticated control requests; scoped grants; consent and retention choice; UI and lifecycle |
| `SpeechSession` | Serialized policy commands; independent capture/playback operations; request identity; cancellation and bounded cleanup |
| Rust `SpeechClient` | Validation, authority, version fencing, admitted tracks, caption recovery and finish decisions |
| `SpeechMediaPort` | Native RTC, permissions, capture/playback, exact publication identity, actual buffer clearing and late acquisition cleanup |
| Observer / `StateFlow` | Caption/event delivery and content-free state; no credentials or raw audio |

No Bota project or provider secret belongs in the SDK. `SpeechGrant` is an
ephemeral participant credential with a redacted `toString()`. Caption and
protocol event bodies may contain private text; they must not be logged. Raw
audio and native RTC objects remain in the media port, outside JNI and future
Flutter metadata calls.

## Integration contract

The host creates the facade with its typed configuration and short-lived grant,
an authenticated `SpeechHostCallbacks`, and a `SpeechMediaPort` factory. Invalid
configuration/grants fail through Rust before the factory is invoked. Await
`ready` before presenting a connected session. Connecting alone starts neither
capture nor audible playback.

```kotlin
val session = SpeechSession.create(configuration, participantGrant,
    mediaFactory = { callbacks -> qualifiedMediaAdapter(callbacks) },
    host = authenticatedSpeechHost,
    observer = captionObserver)
session.ready.await()
session.setInput(true)
session.setListening(true)
session.changeSubscription(selection)
val finish = session.finishInput()
// Inspect completed / interrupted / no_source; none are interchangeable.
session.close()
```

The host identifier above is an application integration point. For the optional
LiveKit microphone adapter, use the factory described below.
`setMicrophone` / `finishMicrophone` are aliases for microphone-backed ports;
`setInput` / `finishInput` also cover future authorized external audio sources.
They do not establish that an external input bridge is already available.

Observers run synchronously on the invoking SDK thread, must not block and must
dispatch UI or suspend calls to the application's scope. Observer exceptions
cannot change media authority. Caption content is emitted through `caption()`;
upsert by `key` and respect `isFinal` and the subscription revision. `state`
contains no caption content. Its track collections are immutable snapshots.

### Independent capture and playback

Capture and playback have separate operation owners. Changing language
immediately silences obsolete playback and starts actual buffer clearing while
capture continues. The SDK admits new audio only after Rust accepts the current
HTTP subscription, worker acknowledgement and matching clear acknowledgement.
Worker events may precede HTTP responses. Superseded responses, foreign senders
and old clear completions cannot reopen obsolete playback.

The port must keep new receive tracks silent until the SDK passes their exact
identity to `setPlayback`. Disabling, closing or holding input synchronously
fences both existing and pending capture acquisition. Cancellation alone is not
proof that a native acquisition stopped.
An input hold remains latched through late `setInput(true)` invocations; only a
fully settled `setInput(false)` clears it. See the [Apple counterpart](apple-speech-session.md)
for the Swift facade and its native-task cancellation contract.

```mermaid
sequenceDiagram
    participant App
    participant SDK as Android session
    participant Core as Rust policy
    participant Media as Native media port
    participant Host as Authenticated host
    App->>SDK: changeSubscription(language)
    SDK->>Core: begin_change
    Core-->>SDK: keep capture, block playback, clear generation
    SDK->>Media: silencePlayback; clearPlayback
    SDK->>Host: changeSubscription
    Note over Media,Host: Native capture continues independently
    Host-->>SDK: current subscription revision
    SDK->>Core: apply_desired
    Media-->>SDK: authenticated worker applied event
    SDK->>Core: event
    Media-->>SDK: buffers actually cleared
    SDK->>Core: buffers_cleared(exact generation)
    Core-->>SDK: admitted current tracks
    SDK->>Media: setPlayback(admitted tracks)
```

### Caption recovery and source finish

Optional host capabilities are explicit. Caption HTTP bodies reach the Rust
validator unchanged. Valid pages advance only the shared cursor; `hasMore`
does not mean a single `recoverCaptions()` call drains all history. The Rust
250 ms / 2 s polling policy schedules subsequent pages. Stale pages are retired
when a subscription changes; authorization loss closes media immediately.

`finishInput()` first holds input silent while retaining the publication. If an
acquisition is still settling, the SDK waits for it before reading its exact
track SID. It then submits the shared source-finish request and polls according
to Rust's deadline. Listening remains available. Only a terminal result releases
the held publication. A retryable/unavailable result does not assert completed
ASR, and `no_source` is distinct from `completed`. Concurrent callers share one
finish operation. A fresh input can start after a successful terminal finish.

### Cancellation and cleanup

Cancellation of a public suspend operation retires the whole session. This is
deliberate: a caller abandoning an acquisition must not leave background capture
owned by an unreachable session. Superseding a language request is separate and
returns `SUPERSEDED` without retiring capture. Use `setInput(false)` to disable
capture while keeping the session; do not cancel a call to express that intent.

Close publishes its one shared completion before invoking callbacks, retires
policy ownership, cancels pending control/media work and synchronously mutes
both directions. It then awaits the port's actual cleanup. Regular media and
subscription operations have a 10 s deadline; caption/finish/renewal HTTP calls
have a 5 s deadline. Close has a 10 s cleanup deadline. A native port must fence
late callbacks, join late acquisitions and preserve unrelated host audio.
`CLEANUP_FAILED` remains the result for every close caller; it is not permission
to release an uncertain audio lease or report successful cleanup.

## Optional LiveKit microphone adapter

The source module `platforms/android/speech-livekit` provides
`dev.bota.sdk.speech.livekit.LiveKitSpeechMedia.create(context, callbacks)`.
Pass this factory to `SpeechSession.create` and supply the existing authenticated
host callbacks. The App must obtain Android microphone permission before enabling
input and reserve exclusive communication-audio ownership until close succeeds.
This module is not included in the existing published base AAR or release
inventory. Its LiveKit 2.29.0 dependency and transitive graph are locked and
SHA-256 verified; JitPack resolution is restricted to the exact upstream
AudioSwitch revision. Do not advertise a published installation coordinate yet.

```kotlin
val session = SpeechSession.create(configuration, participantGrant,
    mediaFactory = { callbacks -> LiveKitSpeechMedia.create(context, callbacks) },
    host = authenticatedSpeechHost,
    observer = captionObserver)
session.ready.await()
session.setInput(true)
session.setListening(true)
// On leaving, await session.close() before releasing the App's audio ownership.
```

Connecting starts neither microphone capture nor audible output. LiveKit's
built-in speaker output stays muted for the room lifetime: its subscribed event
occurs after a remote track starts, so muting only in that callback is insufficient.
The adapter accepts PCM sinks only from the exact processor and Rust-admitted
track SIDs. A native Android `AudioTrack` player consumes those frames. PCM never
crosses the shared-policy ABI or a Flutter bridge. Capture and listening use
independent owners; microphone hold preserves the actual publication SID until
source finish resolves.

The PCM queue is bounded to 200 ms, each device buffer to at most 200 ms, and a
stalled writer to one second. Queue overflow, invalid PCM and stalled output
report blocked playback rather than increasing latency without a bound.
Silence immediately retires queued frames and mutes active players. Clear joins
native pause, flush and release before acknowledging completion. A later selection
cannot reuse a silenced player's queued samples, even when the SID is unchanged.
Normal processor unpublication waits for both the PCM queue and the native
playback head before reporting removal. This wait is bounded to one second;
silence or clear retires it immediately, and a retired completion cannot affect
a later selection. A stalled playback head reports blocked playback.

Submitted input/playback calls carry a local retirement generation. Synchronous
mute/silence retires pending starts; source-finish hold also survives a late
acquisition. Close joins late acquisition/publication, retires callbacks, releases
owned input, clears output and releases the room. Failed cleanup remains a stable
failure and retains exclusive ownership. Automatic RTC reconnect is disabled;
a new session requires fresh host authority. Text streams accept only the current
processor, with eight concurrent readers, a 32 KiB message limit and a five-second
deadline.

`npm run test:android:speech-livekit` runs controlled native-lifecycle/PCM
regressions, strict Kotlin compilation, Android lint and the optional AAR build;
the Android CI lane runs the same gate. A composed check drives this adapter
through the public `SpeechSession` and actual Rust/JNI policy with controlled
RTC and output ports. These checks do not establish cloud RTC,
AEC/double-talk, audible output-tail draining, Bluetooth routing, host conference
coexistence, external capture, consuming-App or release acceptance. The first
physical path must use headphones; speaker/AEC and shared-host ownership remain
separate qualification work.

## Verification and remaining acceptance

| Phase 3 requirement | Implementation and local verification | Conformance |
| --- | --- | --- |
| RTC-O03 / RTC-M02–03: independent speaking, listening and language changes | Separate capture/playback owners; Rust track admission; controlled-port duplex, both acknowledgement orders and stale-response tests | Control behavior verified locally; RTC/device behavior pending |
| RTC-X02: scoped authority | Rust grant/event validation, expiry and fail-closed authorization loss; actual JNI tests for foreign senders and revoked/expired access | Local policy/host conformance; real service revocation pending |
| RTC-X03: last-word finish and caption recovery | Exact held publication, concurrent finish ownership, terminal distinctions, unchanged page validation and retired request IDs | Controlled-port lifecycle verified; actual RTP/ASR tails and network recovery pending |
| RTC-M04: existing meeting integration | Public typed media/host ports; optional native LiveKit microphone module; audio excluded from JNI | External input, shared host audio and consuming-app integration incomplete |
| RTC-X03: normal output tails | Device playback-head drain with bounded timeout and stale-selection retirement | Controlled drain behavior verified; audible cloud/physical tails pending |
| All-platform G3/G6 | Android facade and optional microphone media candidate in source | Apple RTC, Flutter and per-platform package/App/physical qualification remain open |

`SpeechSessionTest` runs deterministic JVM regressions against the actual
Rust C ABI and JNI library. The host JNI builder includes the shipping speech
bridge. Controlled coroutine gates exercise duplex language switching, late
HTTP/caption responses, actual clear acknowledgements, cancellation during
capture and playback resume, finish during pending publication, concurrent
finish, absent/stale source, caption pagination/Unicode, revoked authorization,
expiry, failed/hung connect and retained cleanup failure. Tests use virtual time
for production deadlines and a five-second real settlement watchdog.

Run `tools/android/test-foundation.sh` with the documented JDK/Android toolchain.
The existing API 26/35 instrumentation suite separately exercises the speech
JNI policy. CI, packaging and native tests remain required on the exact final
commit; earlier successful commits are not final-candidate evidence.

These controlled-port tests do not qualify a concrete RTC implementation,
Bluetooth/AEC/background/double-talk behavior, encrypted original capture and
alignment, provider quality/region/cost, weak-network/TURN recovery, application
adoption, Flutter ownership or two-hour/concurrency acceptance. The original
Phase 3 user stories and G1–G6 remain in force, including per-platform G3/G6.
