# Apple speech session orchestration

Status: unreleased Phase 3 source preview for the existing iOS 15+ / macOS 13+
matrix. `SpeechSession` executes the shared Rust policy through the separate
native C ABI. This completes the Apple control facade's source integration;
the concrete native RTC adapter, Flutter bridge, consuming applications and
physical audio qualification remain incomplete. All five SDK families remain
in the first delivery and the original G1–G6 gates remain open where unproved.

## Public contract and ownership

The host supplies a `SpeechConfiguration`, a short-lived `SpeechGrant`, its
authenticated `SpeechHostCallbacks` and a `SpeechMediaPort` factory. Rust validates
the configuration/grant before the factory runs. No Bota project/provider secret
or raw audio crosses the policy boundary. The media port owns native audio,
permissions, RTC subscriptions, exact track identities and actual teardown.

```swift
let session = try SpeechSession(configuration: configuration, grant: participantGrant,
                                mediaFactory: makeQualifiedMediaPort,
                                host: authenticatedSpeechHost, observer: observer)
try await session.ready()
try await session.setInput(true)
try await session.setListening(true)
try await session.changeSubscription(selection)
let result = try await session.finishInput()
// Inspect completed, interrupted or no_source before presenting a final result.
try await session.close()
```

`makeQualifiedMediaPort` and `authenticatedSpeechHost` are integration points,
not bundled RTC/HTTP clients. `setMicrophone` and `finishMicrophone` alias the
input methods. External-source transport remains a separate adapter obligation.
The `state` snapshot contains no caption text. `SpeechObserver` emits immutable
state, caption upserts, validated protocol events and stable errors; callbacks
must not block and UI work must be dispatched to the application's actor/task.
Events and caption records may contain private text and must not be logged.
Use the caption's stable `key`, final flag and subscription revision for text UI.

The [Android contract](android-speech-session.md) describes the shared policy,
language-switch sequence, caption cursor semantics and source-finish outcomes.
Apple uses the same Rust commands and unchanged authenticated HTTP response
bodies; no authority, subscription or transcript reducer is copied into Swift.

## Swift execution and cancellation

A recursive lock serializes policy commands, owner publication and synchronous
mute/silence/hold. Separate capture and playback owners execute asynchronous IO.
Language switching immediately blocks obsolete audio while input continues;
the desired HTTP revision, worker-applied event and exact buffer-clear generation
must all agree before new tracks become audible. The port must keep fresh RTC
tracks silent until explicitly admitted.

Source finish holds the original publication silent, waits for any pending
acquisition, then reads its exact track SID. A hold must survive a late
`setInput(true)` invocation: that call must not release the hold. Release it only
when `setInput(false)` has actually stopped the held publication. The SDK waits
for that stop before a terminal finish call returns. Listening stays independent.
`no_source`, `interrupted` and `completed` are distinct; an unavailable finish
does not authorize input restart or claim that ASR completed the final words.

Swift task groups are not used to race a deadline against native IO, because a
group waits for its cancelled children. A bounded `SpeechCall` owns one result,
its native task, deadline and cancellable waiters. Completion ownership is
retired before callbacks, including cancellation before the task body starts.
Late native results cannot settle the call again. Operation timeout/cancellation
does not prove native resource cleanup; the port must fence late callbacks and
join late acquisition during close.

Cancelling any public async control call closes the session, preventing abandoned
capture. Superseding a language request instead returns `superseded` and keeps
input running. Cancelling one `close()` waiter does not cancel the shared cleanup.
Close first retires policy, cancels pending work and synchronously silences both
directions, then joins media cleanup. Its stable result is shared by later callers.
`cleanupFailed` means uncertain native ownership; do not release/reuse the audio
lease or present successful cleanup. Call `close()` explicitly when leaving.

Media/subscription work and close cleanup have 10-second deadlines; caption,
source-finish and grant-renewal HTTP calls have 5-second deadlines. Shared Rust
policy owns polling, the source-finish deadline and grant expiry. Normal backend
response bodies reach Rust unchanged; malformed or unauthorized responses cannot
be reinterpreted as successful local state.

## Requirement conformance and verification

| Requirement | Source evidence and local verification | Remaining acceptance |
| --- | --- | --- |
| RTC-O03 / RTC-M02–03: simultaneous input/listening and individual language changes | Separate IO owners, both HTTP/event orders, delayed buffer clear and superseded HTTP checks through actual Rust | Concrete RTC and physical audio routes/AEC/double-talk |
| RTC-X02: scoped current authority | Shared grant/event validation; authorization-revocation and expiry checks | Actual backend/provider revocation and network behavior |
| RTC-X03: tail completion and caption recovery | Held exact publication, concurrent finish, absent source, cursor/Unicode checks, retired/malformed page rejection | Real RTP/ASR tails, weak-network recovery and original-archive alignment |
| RTC-M04: host meeting reuse | Typed metadata/host/media ports; raw audio stays outside C ABI | Native media adapter, host ownership coordinator and App integration |
| G3 / G6 across all five families | Apple control source and controlled-port checks | Full package/App/device qualification, Flutter and remaining native media work |

`SpeechSessionChecks.swift` contains one set of behavior checks. The normal Apple
package runs them through `SpeechSessionTests` under XCTest. For a Mac with only
Command Line Tools, `tools/speech/test-apple-host.sh` compiles the same checks and
actual production Swift sources against the shipping Rust static library. It
does not emulate XCTest, replace Rust or test a separately maintained reducer.
Checks use explicit synchronization gates and five-second settlement watchdogs.
The suite also verifies that a timeout returns while a deliberately uncooperative
native task remains pending, and that close waits for cleanup after cancellation.

Local host checks and Swift 6 strict-concurrency compilation do not establish
Xcode/XCFramework/package acceptance. The full Apple CI lane, exact final-commit
checks, real RTC, application and device acceptance remain independently required.
