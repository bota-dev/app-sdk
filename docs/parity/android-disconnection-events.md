# Android confirmed disconnection propagation

Status: published in `2.0.0-beta.8`; see the
[release review](../../release/evidence/2.0.0-beta.8-preflight.md).
The source and CI history below precede publication. Published-example checks
passed native Kotlin radio-off/reconnect and RN loss delivery, but RN reconnect
failed and Flutter missed an adapter-off event. Full recovery remains partial.
The published beta.7 examples exposed this gap on Android 16 with Bota Pin
firmware 1.0.19. This change reports transport loss without a status subscription.

## Ownership and behavior

The GATT driver already filters confirmed disconnects by peripheral and transport
generation. The runtime forwards accepted events to DeviceManager as well as the
existing encrypted-upload ownership reset path. DeviceManager accepts only its
attached runtime and exact verified transport generation, clears the verified
device registry and client presence, closes status observers, and publishes null
through `connectionUpdates()`.

Loss cleanup does not unsubscribe by peripheral identifier: a replacement GATT
session may already own it. Connection acceptance checks that the transport
observed before metadata reads still owns the device afterward. Initial values
and subsequent notifications use the same manager lock. Detach cancels observation.

Flutter already consumes the native connection stream. RN now owns an observer
from configure through destroy and forwards connected-to-null transitions through
the existing `onDeviceDisconnected` event. Initial and repeated null values do
not create extra notifications. The status-error path remains for compatibility.

This does not add automatic reconnect attempts, report adapter power state,
authorize upload fallback, change firmware, or alter provisioning. The fix is published in beta.8; apps clear
selection on loss and explicitly reconnect after Bluetooth is restored.

## Source and automated design review

Reviewed against Bota App SDK Architecture sections 5.2 (platform link events),
6.2-6.4 (native/framework ownership), and 8 (disconnect invalidates client
presence), plus Connection Management section 2.1 (unexpected loss and recovery).
The Android lifecycle and RN DeviceManager compatibility plans provide
implementation context. This is the bounded loss-notification fix exposed by
the examples, not completion of the broader automatic-reconnect policy.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Loss without a status subscription | Passing native manager and RN Android adapter regressions | matched in automated tests |
| Invalidate verified state and presence | Exact-generation handler; passing registry/presence assertions | matched in automated tests |
| Preserve replacement connections | Passing stale-generation regression; runtime lease check | matched in automated tests |
| Reject loss during metadata reads | Passing controlled-read regression; transport identity recheck | matched in automated tests |
| Observer teardown | Passing status closure/detach and RN cancellation regressions; loss cleanup does not unsubscribe a replacement | matched in automated tests |
| Native/framework ownership and compatibility | Existing streams/events; Android source/binary consumers and RN adapter gates pass; Flutter delegates to the native stream | matched for reviewed source and consumers |
| Native packaging and permission lanes | Android AAR, lint, unit suites, API 26/35 emulators; all other CI platform jobs | matched in CI |
| Automatic reconnect policy | No reconnect loop added; callers reconnect explicitly | not implemented by this change |

## Automated evidence

At source `9acff6511f5b1b64ecc4f00ec49bb188034861f2`,
[CI 36629977148](https://github.com/bota-dev/app-sdk/actions/runs/36629977148) and
[License Gate 36629977081](https://github.com/bota-dev/app-sdk/actions/runs/36629977081)
passed. The PR merge revision `e00865e578a88681bdb1ccec46be6d01182b693c` has the
same Git tree as that source commit. These checks include the native loss,
stale-generation, metadata-read and observer-teardown regressions, plus the RN
loss-without-status-subscription regression.

The Android artifact is `11063110461`, named
`android-ci-e00865e578a88681bdb1ccec46be6d01182b693c`. Its downloaded ZIP digest
was independently verified as
`3c1649a94a3a25c29eee763f75e8b99f6f06fc683c734cee7f3b7959bfe5eb38`.
The candidate AAR SHA-256 is
`265e4c82acd9db59603ddfab53501d816693fed428d546eeda677fcc08dd1275`.
Its unchanged beta.7 package coordinate is local candidate metadata, not a
replacement of the immutable public beta.7 artifact. Candidate consumers must
resolve `dev.bota` exclusively from the isolated candidate repository.

Initial Windows Gradle attempts stalled before compilation during dependency
instrumentation. They establish no regression-test result or observed failing
baseline. Tests were authored before the implementation; passing execution
was obtained in CI. CI and License Gate must also pass at the final pushed
revision before merge or release.

The physical acceptance procedure is: observe `connectionUpdates()` without
subscribing to status, connect by verified exact serial, disable phone Bluetooth,
observe null without calling Disconnect, restore Bluetooth, reconnect and read
fresh status, then disconnect. Record the candidate digest, firmware, phone and
result in the [beta.8 release review](../../release/evidence/2.0.0-beta.8-preflight.md).
Radio-off evidence must not be generalized to out-of-range, background, other
devices, or end-to-end RN/Flutter UI behavior. Published-example adoption and
physical UI evidence are tracked in the
[examples review](https://github.com/bota-dev/examples/blob/main/docs/independent-examples-review.md#beta8-adoption).

## Published-example limitation (2026-09-30 UTC)

On Samsung SM-A166U1 / Android 16 with the same exact-serial Bota Pin on firmware
1.0.19, public beta.8 Kotlin passed loss notification and explicit reconnect with
fresh status. RN cleared selection/status on radio-off, but two reconnects failed
with GATT 133. Flutter connected/read status after another phone Bluetooth cycle,
then retained stale connected state after radio-off; subsequent reconnect failed.
The examples review records exact source, CI artifacts and APK checksums.

Flutter's radio-off log showed `onClientRegistered(100)` and GATT client cleanup
without `onConnectionStateChange(DISCONNECTED)`. The framework platform currently
emits confirmed loss from that callback and has no adapter-state receiver. Adapter
shutdown without a GATT callback is therefore an uncovered native path, not proof
that the Dart connection mapping drops null. This does not establish the cause
of the separate reconnect failures.

Follow-up acceptance must cover adapter shutdown without a GATT callback, exact
generation invalidation, stale/duplicate callbacks, pending-operation cleanup,
observer teardown, and fresh explicit reconnect through RN and Flutter. It needs
new regression and phone evidence and a new public version; beta.8 is immutable.
Examples must continue using public packages rather than implementing private
GATT or polling substitutes. No automatic reconnect or upload-fallback authority
is introduced by this finding.

## Adapter-off follow-up

Scope: Android platform lifecycle cleanup, with no new public API or automatic
reconnect loop. The native receiver will observe the protected
`BluetoothAdapter.ACTION_STATE_CHANGED` broadcast on the GATT handler and retire
the current sessions on adapter shutdown. A stale OFF broadcast while the adapter
is already ON must not clear a replacement session. Context receiver registration
uses the API-appropriate exported flag for the privileged Bluetooth sender and is
paired with teardown; see [Android broadcast guidance](https://developer.android.com/develop/background-work/background-tasks/broadcasts).

Acceptance requires deterministic regressions for loss without a GATT callback,
settling pending connection/read/notification work, cancelled-connect cleanup,
duplicate and stale callbacks, receiver teardown, and a delayed old disconnect
completing after reconnect. Framework tests run with Robolectric on API 26 and
35; they are simulated Android lifecycle evidence, not physical acceptance.
The connected-phone RN and Flutter radio-off/reconnect checks must then be
repeated against the exact candidate AAR. Public beta.8 remains unchanged until
a new immutable release passes its publication gates.

The implementation uses one terminal cleanup path for GATT callbacks, adapter
shutdown and cancelled connection attempts. It closes the native handle before
settling pending work and publishing the exact-generation loss event. Closing the
SDK unregisters its receiver and terminates pending work. Driver disconnect
completion clears ownership only if its captured generation is still current.

Baseline verification reproduced nine failures: four framework lifecycle cases
on both API 26 and 35, plus delayed old-disconnect completion in the driver. The
other 15 selected driver tests passed. Robolectric is test-only; its dependencies
are locked and all 66 new artifact/metadata hashes were independently compared
with Google/Maven Central checksums, without changing existing hashes. All nine
regressions pass after the fix. The local full suite passed 246/248 tests; two
encrypted-transfer tests failed with a directory `AccessDeniedException` and
a settlement timeout on Windows. A control run restored both original
production files and reproduced those same two failures, then restored the exact
candidate. No test is disabled; full hosted CI remains required. Physical and
publication acceptance remain pending.
Local release lint cannot complete on Windows because its native prerequisite
executes the repository's Bash Rust build script. The hosted native/lint gates
remain required; no prerequisite is skipped to claim a local lint pass.

The first hosted follow-up run built the release AAR, then stopped at lint's
test-classpath verification: clean Linux resolution also requested the
Guava 33.6.0-jre parent POM and Bouncy Castle 1.85 BOM POM. Their SHA-256 entries
were added after checking the bytes against Maven Central's SHA-512 checksums.
Existing entries and strict verification remain unchanged. The exact amended
revision must pass the complete hosted checks before main integration.
