# Apple speech session orchestration

Status: unreleased Phase 3 source preview for the existing iOS 15+ / macOS 13+
matrix. `SpeechSession` executes the shared Rust policy through the separate
native C ABI. An optional LiveKit microphone adapter now connects the facade
to native capture and bounded playback. External native input, Flutter, consuming applications and
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

## Optional LiveKit microphone adapter

The source package `platforms/apple-speech-livekit` exports `BotaSpeechLiveKit`.
It pins LiveKit Swift 2.18.0 and its resolved dependency revisions. It is not in
the existing published SwiftPM/CocoaPods packages or release inventory. Its
transitive native binaries, SPDX/notices and public distribution still need the
normal release review. The local package dependency on the Apple facade is a
source-preview integration, not a published installation coordinate.

```swift
import BotaSpeechLiveKit

let session = try SpeechSession(configuration: configuration, grant: participantGrant,
    mediaFactory: { try LiveKitSpeechMedia.create(callbacks: $0) },
    host: authenticatedSpeechHost, observer: observer)
try await session.ready()
try await session.setInput(true)
try await session.setListening(true)
// On leaving, await session.close() before releasing the App's audio reservation.
```

The App must obtain microphone permission and reserve exclusive use of LiveKit's
process-wide audio engine. Configure a content-free LiveKit logger before its
first use; the factory also requests one. An active, prewarmed or manually
rendered engine is rejected. The adapter saves and gates the mixer gains before
connecting: built-in playout, app audio and sound-player capture stay silent,
and microphone gain opens only for an admitted input owner. This microphone
candidate does not share an existing meeting's audio engine.

Only the exact processor and Rust-admitted track SIDs reach copied native PCM.
`AVAudioPlayerNode` and `AVAudioEngine` handle playback; no samples cross the
Rust ABI. Each frame is at most 100 ms, total outstanding audio at most 200 ms,
and no more than 64 frame reservations or 16 tracks are retained. These are
application queue limits, not a measured bound on hardware output latency.
Retiring a track releases its pending reservations without depending on an OS
completion callback. Silence mutes players immediately; clear joins node/engine
stop and reset before acknowledging the shared policy's clear generation.

Normal unpublication waits for `.dataPlayedBack` completions, with a one-second
deadline. A language change or clear retires that wait. Stalled/invalid playback
reports a stable error while capture remains independently controlled. Source
finish keeps the exact original publication silent until the backend settles.
Close joins late acquisition/publication and vendor readers/subscriptions,
disposes input and output, and restores mixer gains only after successful
cleanup and a stopped vendor engine. Uncertain cleanup retains exclusive
ownership. Automatic RTC reconnect is disabled; reconnect needs fresh authority.
Text streams are limited to the current processor, eight concurrent readers,
32 KiB per message and five seconds.

`bash tools/speech/test-apple-livekit.sh --host` compiles the real vendor SDK and
unchanged shipping Swift speech facade against the actual Rust library, then
runs the same behavior checks used by XCTest. It works with macOS Command Line
Tools and does not emulate XCTest. With Xcode and the normal generated
XCFramework, run `npm run test:apple:speech-livekit`. CI additionally compiles
the optional package for iOS. A composed test exercises the public
`SpeechSession` through Rust and this adapter with controlled RTC/device ports.

Start physical qualification with headphones. Audible tails, permission and
interruption handling, Bluetooth/background routes, AEC/speaker double-talk,
external-source ownership and actual App/backend sessions remain separate
acceptance work. No component check establishes G3/G6 completion.

## Requirement conformance and verification

| Requirement | Source evidence and local verification | Remaining acceptance |
| --- | --- | --- |
| RTC-O03 / RTC-M02–03: simultaneous input/listening and individual language changes | Separate IO owners, both HTTP/event orders, delayed buffer clear and superseded HTTP checks through actual Rust | Concrete RTC and physical audio routes/AEC/double-talk |
| RTC-X02: scoped current authority | Shared grant/event validation; authorization-revocation and expiry checks | Actual backend/provider revocation and network behavior |
| RTC-X03: tail completion and caption recovery | Held exact publication, concurrent finish, absent source, cursor/Unicode checks, retired/malformed page rejection | Real RTP/ASR tails, weak-network recovery and original-archive alignment |
| RTC-M04: host meeting reuse | Typed ports and optional native LiveKit microphone adapter; raw audio stays outside C ABI | External-source adapter, shared host ownership coordinator and App integration |
| RTC-X03: output tail and buffer retirement | Bounded native queue, played-completion drain, cancelled clear and retired reservation checks | Audible tails, native clock behavior and physical latency |
| G3 / G6 across all five families | Apple control and microphone media source with controlled-port checks | Full package/App/device qualification, Flutter and external native media work |

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
