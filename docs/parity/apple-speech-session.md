# Apple speech session orchestration

Status: unreleased Phase 3 source preview for the existing iOS 15+ / macOS 13+
matrix. `SpeechSession` executes the shared Rust policy through the separate
native C ABI. Optional LiveKit microphone and authorized external PCM adapters
connect the facade to native input and bounded playback. Host conference integration, Flutter media adoption, consuming applications and
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
input methods. The optional authorized external PCM factory is described below.
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
disposes input and output, explicitly stops the recording started by LiveKit,
and restores mixer gains only after successful
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
host-source ownership and actual App/backend sessions remain separate
acceptance work. No component check establishes G3/G6 completion.

## Authorized external PCM input

`LiveKitSpeechMedia.createExternal(callbacks:input:)` accepts an
`ExternalPCMInput(participantId:memberGeneration:)`. The backend must admit the
participant as immutable `source_kind=host_external`; the host authorizes one
participant's original audio and owns its format conversion, mute/end events,
conference track and audio session. The factory validates participant/member
generation against the grant before connecting. Neither carrier metadata nor
the grant proves the contents of host-supplied samples. Generated translation,
mixed conference audio and arbitrary system capture are outside this contract.

```swift
let input = try ExternalPCMInput(participantId: participantGrant.participantId,
                                 memberGeneration: participantGrant.memberGeneration)
let session = try SpeechSession(configuration: configuration, grant: participantGrant,
    mediaFactory: { try LiveKitSpeechMedia.createExternal(callbacks: $0, input: input) },
    host: authenticatedSpeechHost, observer: observer)
try await session.ready()
try await session.setInput(true)
input.setMuted(false) // Only when the authorized host source is unmuted.
// In the host's native audio callback: input.offer(pcm10ms)
// Forward every host mute change with input.setMuted(hostMuted).
// Normal completion: await session.finishInput(), then detach the host callback.
// Unexpected source loss: input.end(). Leaving: await session.close().
```

Each offer copies 480 mono PCM16 samples at 48 kHz from an `AVAudioPCMBuffer`.
The input starts muted and accepts no frames before grant validation and input
enablement. At most 20 frames / 200 ms are retained. An `AVAudioSourceNode`
converts those samples to normalized Float PCM as the no-device engine requests
them, including partial-frame reads. Empty input supplies silence. Host mute,
SDK hold and close clear both queued frames and any partly consumed frame.
Malformed, overflowing or stale input fails the branch. Audio never crosses
C ABI, Pigeon or Dart; arrival time is not an original-capture clock.

The host must reserve the process-wide LiveKit engine and retain its standard
audio observer chain. The factory rejects an active/prewarmed/manual engine,
an existing capture processing delegate or an occupied mixer observer tail.
It installs an owned source at that tail and enables manual rendering before
any connection, avoiding physical microphone access and LiveKit AVAudioSession
configuration. The original host audio route remains the host's responsibility.
Simultaneous use of another LiveKit room is unsupported; use a separate host
capture engine and qualify coexistence before adoption.

Manual mode's main mixer carries outgoing input, so its gain remains one while
microphone, app-audio and sound-player gains stay zero. Remote audio has no
automatic device playout in this mode; only the independently admitted native
playback owner can render it. The source generates frames on demand and does
not enqueue audio into LiveKit's player/mixer injection API.

Close retires input before joining native operations, stops the explicit native
recording start, verifies the engine is stopped and its observer tail remains
owned, then removes that tail and restores the prior mode/gains. Engine teardown
resets input mixer gains, so those resets are not treated as ownership loss.
Uncertain cleanup retains the exclusive reservation and stable close failure.
Unexpected `input.end()` fails the session; only shared-policy `finishInput`
can establish a normal source finish while listening continues.

Controlled tests cover grant binding, copies, independent mute/hold, partial
reads, capacity/age limits, invalid formats, source end and late callbacks.
A native no-device test starts the actual pinned vendor engine, observes the
synthetic samples at its source node and verifies complete stop/restoration.
It does not connect RTC or prove encoded publication, cloud ASR/translation,
host meeting coexistence, hardware routing or original archival alignment.

## Requirement conformance and verification

| Requirement | Source evidence and local verification | Remaining acceptance |
| --- | --- | --- |
| RTC-O03 / RTC-M02–03: simultaneous input/listening and individual language changes | Separate IO owners, both HTTP/event orders, delayed buffer clear and superseded HTTP checks through actual Rust | Concrete RTC and physical audio routes/AEC/double-talk |
| RTC-X02: scoped current authority | Shared grant/event validation; authorization-revocation and expiry checks | Actual backend/provider revocation and network behavior |
| RTC-X03: tail completion and caption recovery | Held exact publication, concurrent finish, absent source, cursor/Unicode checks, retired/malformed page rejection | Real RTP/ASR tails, weak-network recovery and original-archive alignment |
| RTC-M04: host meeting reuse | Optional microphone and external PCM factories; binding, queue and lifecycle tests; actual no-device source-node check; raw audio stays outside C ABI | Host bridge/coordinator, actual RTC publication and App integration |
| RTC-X03: output tail and buffer retirement | Bounded native queue, played-completion drain, cancelled clear and retired reservation checks | Audible tails, native clock behavior and physical latency |
| G3 / G6 across all five families | Apple control, microphone and external PCM source, plus the [Flutter native bridge](flutter-speech-session.md) | Full package/App/device and host conference qualification |

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

The November 2 source run `41418137825` passed the optional adapter's XCTest
checks and all other functional lanes, but its generic iOS compile rejected
Xcode's dependency warning suppression combined with warnings-as-errors. The
iOS command now explicitly sets `SWIFT_SUPPRESS_WARNINGS=NO` while preserving
strict concurrency and warnings-as-errors. The corrected revision needs fresh
CI; the preceding macOS success does not establish an iOS build or audio result.

The follow-up run `41440415636` again passed the adapter's XCTest checks but
exposed a second iOS build configuration issue: command-line complete-concurrency
and warnings-as-errors overrides also applied to LiveKit's generated Swift 5
UniFFI callback tables. The generic iOS check now preserves dependency-declared
compiler modes. Owned Apple targets explicitly use Swift 6, and the build helper
fails on any iOS compiler warning in the owned facade/adapter sources. Vendor
diagnostics remain visible; no vendor source or warning is suppressed. This
correction requires its own fresh CI result.

The Apple package/consumer lane in run `41445677447` passes at `55a545df`,
including the optional module's XCTest checks and generic iOS build. License
run `41445676767` also passes. Those results qualify that source lane; later
Flutter changes still require their own exact-revision CI, and physical audio
acceptance remains open.
