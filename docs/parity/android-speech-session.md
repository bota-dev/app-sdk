# Android speech session orchestration

Status: unreleased Phase 3 source preview. The first delivery still includes
Apple, Android, Flutter, React Native and Web. This Android control facade does
not complete the native RTC adapter, Flutter integration, application adoption
or the Phase 3 qualification gates.

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

The adapter and host identifiers above are application integration points, not
bundled implementations. The concrete native RTC adapter is still required.
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

## Verification and remaining acceptance

| Phase 3 requirement | Implementation and local verification | Conformance |
| --- | --- | --- |
| RTC-O03 / RTC-M02–03: independent speaking, listening and language changes | Separate capture/playback owners; Rust track admission; controlled-port duplex, both acknowledgement orders and stale-response tests | Control behavior verified locally; RTC/device behavior pending |
| RTC-X02: scoped authority | Rust grant/event validation, expiry and fail-closed authorization loss; actual JNI tests for foreign senders and revoked/expired access | Local policy/host conformance; real service revocation pending |
| RTC-X03: last-word finish and caption recovery | Exact held publication, concurrent finish ownership, terminal distinctions, unchanged page validation and retired request IDs | Controlled-port lifecycle verified; actual RTP/ASR tails and network recovery pending |
| RTC-M04: existing meeting integration | Public typed media/host ports; audio excluded from JNI | Adapter and consuming-app integration incomplete |
| All-platform G3/G6 | Android facade only in this change | Apple, Flutter, actual media and per-platform package/App/physical qualification remain open |

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
