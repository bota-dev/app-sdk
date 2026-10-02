# Android confirmed disconnection propagation

Status: published in `2.0.0-beta.8`; see the
[release review](../../release/evidence/2.0.0-beta.8-preflight.md).
The source and CI history below precede publication. Published-example checks
passed native Kotlin radio-off/reconnect and RN loss delivery, but RN reconnect
failed and Flutter missed an adapter-off event. Published recovery remains partial.
The adapter-off follow-up, later published in beta.9, passed three RN and three Flutter
radio-off/explicit-reconnect cycles on the recorded Android phone/device pair.
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
without `onConnectionStateChange(DISCONNECTED)`. The beta.8 framework platform
emitted confirmed loss from that callback and had no adapter-state receiver. Adapter
shutdown without a GATT callback was therefore an uncovered native path, not proof
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
candidate. No test is disabled. The subsequent hosted and bounded physical
results are recorded below; publication acceptance remains pending.
Local release lint cannot complete on Windows because its native prerequisite
executes the repository's Bash Rust build script. The hosted native/lint gates
remain required; no prerequisite is skipped to claim a local lint pass.

The first hosted follow-up run built the release AAR, then stopped at lint's
test-classpath verification: clean Linux resolution also requested the
Guava 33.6.0-jre parent POM and Bouncy Castle 1.85 BOM POM. Their SHA-256 entries
were added after checking the bytes against Maven Central's SHA-512 checksums.
Existing entries and strict verification remain unchanged. The exact amended
revision must pass the complete hosted checks before main integration.

### Follow-up design review

Reviewed against App SDK Architecture sections 5.2, 5.4, 6.2–6.4 and 8, and
Connection Management section 2.1. The broader design's automatic reconnect
policy remains outside this bounded loss-notification and explicit-reconnect fix.

| Requirement | Implementation and verification evidence | Status |
| --- | --- | --- |
| Platform reports loss without a GATT callback | Adapter receiver invokes the same terminal cleanup as GATT disconnect; API 26/35 framework regressions pass locally | matched in simulated lifecycle tests |
| Release native ownership and pending work | GATT closes before pending work and observers settle; pending connect/read/notification and cancellation regressions pass | matched in simulated lifecycle tests |
| Preserve newer sessions and serialized ownership | Receiver and GATT cleanup run on one handler; stale OFF/callback/disconnect and delayed driver completion regressions pass | matched in automated tests |
| Receiver/observer lifecycle | Close unregisters the receiver, settles pending connect and terminates streams; regression passes on API 26/35 | matched in automated tests |
| Frameworks delegate to native transport | Public RN and Flutter bindings are unchanged; both candidate phone labs received native loss events without app-side recovery substitutes | matched for tested Android bindings |
| RN/Flutter loss notification and explicit reconnect | Three radio-off/reconnect/status cycles per framework on the exact candidate and recorded phone/device pair | matched for this bounded physical check |
| General connection reliability and wider lifecycle coverage | One initial RN timeout recovered on retry; no out-of-range/background, other-phone, iPhone or transfer-interruption checks in this follow-up | partial; remaining cases unverified |
| Published package availability | Beta.8 remains immutable; follow-up needs a new synchronized version | not implemented by this source fix |

### Exact candidate evidence

Follow-up source `4d36de598de1dbd2e573fca85e06724ac17abf15` passed
[CI 36743986531](https://github.com/bota-dev/app-sdk/actions/runs/36743986531) and
[License Gate 36743990238](https://github.com/bota-dev/app-sdk/actions/runs/36743990238).
All platform jobs and the final release-candidate inventory passed. Android
included the complete unit suite, release lint, native/legacy/RN consumers and
API 26/35 emulator lanes. The two local Windows transfer failures did not recur
in hosted CI.

Android artifact `11112626484` has verified ZIP SHA-256
`1a62c1cece84d917bfcb2c15b64e5bfb777406aca4e79b2a102acbac51788694`.
The manifest identifies that exact source and the AAR SHA-256 is
`f8beeb1a97e1e378c616eb83d5c89a46bfc279b15a8d65a57b2409dd8190eaf3`.
The beta.8 coordinate here is isolated candidate metadata; it does not replace
the public beta.8 artifact.

Both phone labs derive from examples revision
`022edbbb214927a53e2cc4774f674abcb0da16bd`. Their public beta.8 RN/Dart bindings
are unchanged. Gradle resolves `dev.bota` exclusively from the candidate
repository; resolved-artifact checks verify the AAR hash above in both apps.
Lab-only UI additions display the discovered transport identifier for target
selection and the SDK-read firmware beside the verified serial. Separate lab
application IDs avoid overwriting the installed public examples. There are no
app-side recovery, GATT or polling substitutes.

The Flutter debug APK SHA-256 is
`bb0cc56059c34e590ee88e9a0b0600c4df6c7294d7aa09d02c2df5ff29fc1332`.
The self-contained RN release-mode test APK SHA-256 is
`ac130501732c4ec3cce03385f53c70cd9dcbb1afd2fc4a3a9b846b1445354204`;
it uses the example's debug signing and needs no Metro server. Both local
Android builds passed. RN type/identity checks and Flutter analysis also passed.

### Physical acceptance (2026-09-30)

Samsung SM-A166U1 / Android 16 (API 36), with the same Bota Pin verified by the
SDK's exact serial read and firmware `1.0.19`. The advertising name alone was
not accepted as identity. Tests used only discovery, connection, identity/status
reads and phone Bluetooth cycles; no wearable flash, provisioning, reset,
recording, upload or deletion was performed.

| App | Initial connection | Radio-off and explicit reconnect |
| --- | --- | --- |
| Flutter | First attempt verified serial/firmware and read status | 3/3 cycles automatically cleared connected state and disabled status reads; each first reconnect verified identity/firmware and read fresh status |
| React Native | First attempt timed out after 10 seconds (`Some(-408)`); the log shows `cancelOpen`, `close` and `unregisterApp`. A retry in the same app session succeeded without another radio cycle | 3/3 cycles automatically removed connected/status actions; each first reconnect verified identity/firmware and read fresh status |

Neither app was restarted or manually disconnected between the three cycles.
After each restore, the test used the existing ten-second scan and connect UI.
Scoped GATT logs show native `close()` on all six adapter shutdowns without a
`connected=false` callback; the final explicit Disconnect did receive that
callback. No GATT 133 occurred during these tests. This verifies the previously
missed physical adapter-off path and bounded repeated explicit recovery. It
does not prove that every connection attempt succeeds or that all causes of
GATT 133 are fixed.

The test apps were explicitly disconnected and stopped afterward. Phone
Bluetooth was restored to ON, and no development-server forwarding remained.
Published beta.8 examples still require a new immutable SDK release and package
adoption before receiving this fix. Out-of-range/background recovery, other
hardware/platforms, automatic reconnect and transfer interruption remain outside
this acceptance claim.

## Published beta.9 follow-up

The adapter-off implementation is now published in synchronized `2.0.0-beta.9`
from source `89cb6f14eb0ea6327c196ac2cbeb8215df3423bd`. Exact-main CI,
protected publication, public native consumers and Flutter archive verification
passed; see the [release evidence](../../release/evidence/2.0.0-beta.9-preflight.md#publication).
The candidate sections above retain their original pre-version package scope.
Final public-package example builds and phone observations are tracked in the
[examples review](https://github.com/bota-dev/examples/blob/main/docs/independent-examples-review.md#beta9-adoption).
This publication does not broaden the physical or automatic-reconnect claims.

## Explicit disconnect without an Android callback

Status: published in [beta.10](../../release/evidence/2.0.0-beta.10-publication.md).
The earlier beta.9 artifacts
remain immutable. This follow-up addresses explicit disconnect timeout/cancellation
while the adapter stays on and Android does not deliver its disconnect callback.
It is separate from adapter shutdown and from the example's observed GATT 8/133
reconnect failures, whose failed clients already closed promptly.

Previously, cancellation removed only the platform's waiting continuation. The
driver's `finally` then removed generation ownership, leaving the native GATT
open until replacement or SDK close. Merely closing that GATT on cancellation
would still lose an event delivered after driver ownership was removed.

Acceptance requires exact-client closure, settlement of pending work and
notification streams, one accepted generation-tagged loss, and facade/registry/
presence invalidation while preserving the caller's timeout or cancellation.
Both event-before-finally and event-after-finally ordering must work. Old cleanup,
duplicate events and late callbacks must preserve a newer same-peripheral session.
The existing runtime loss collector owns encrypted-upload cleanup; timeout is
not authority to delete files, reset the device or start a competing upload path.

The design authority is App SDK Architecture sections 5.2, 5.4, 6.2-6.4 and 8,
plus Connection Management section 2.1. Platform lifecycle tests use Robolectric
API 26/35; driver and facade tests use controlled event ordering. These are
simulated lifecycle checks, not physical-device or general reconnect acceptance.

### Implementation and verification

The platform's cancellation handler retires the captured GATT generation through
the existing terminal cleanup path. The driver keeps one retired generation per
peripheral until its delayed native loss is consumed, a replacement starts, or
the driver closes. Consuming retired loss does not cancel the peripheral queue
again: explicit disconnect already cancelled its old work, and a new connection
may now be waiting there. The original source fix changed no public API, package
version, firmware behavior or automatic reconnect policy. The beta.10 candidate
subsequently synchronizes package versions to release this fix.

The unchanged-production baseline ran 29 tests and reproduced four failures:
native closure on API 26 and 35, delayed driver loss, and delayed facade cleanup.
After the fix, all 61 tests across `FrameworkAndroidBluetoothPlatformTest` (10),
`BluetoothGattHostTest` (22), `DeviceManagerTest` (25) and `DeviceRuntimeTest` (4)
passed locally. Independent source/test review found no blocking issue. The
existing full CI and License Gate remain required for the exact revision before
main integration; they cover packaging and consumers beyond these local checks.

| Requirement / authority | Implementation and evidence | Status |
| --- | --- | --- |
| Platform lifecycle, App SDK Architecture section 5.2 | Exact captured GATT closes with the callback withheld and adapter still on; pending read and notification streams fail; API 26/35 regressions pass | matched in simulated lifecycle tests |
| Cancellation and failure remain observable | Driver/facade regressions preserve timeout and caller cancellation, then observe delayed native loss | matched in controlled tests |
| Native/framework state, sections 6.2-6.4 and 8 | Actual driver loss flow clears facade connection updates, registry and client presence after failed disconnect; existing runtime collector retains encrypted-ownership reset | matched in driver/facade tests and runtime path review |
| Serialization and replacement, section 5.4 | Late and duplicate loss cannot clear a replacement; queued reconnect survives retired loss; driver close clears retained markers | matched in controlled tests |
| Connection Management section 2.1 | Explicit disconnect performs local cleanup only; no reconnect loop, firmware mutation or upload fallback added | matched by source review |
| Publication and physical reliability | Beta.9 unchanged; no new physical-device test or claim about the earlier GATT 8/133 failures | unverified beyond the recorded simulated scope; new publication required for consumer adoption |

Changed-symbol and timeout/cancellation searches covered the SDK docs, workspace
internal/public docs and repository README/ARCHITECTURE/AGENTS/CLAUDE surfaces.
No target design or released API contract changed. This record and the SDK's
README, architecture and contributor guidance describe the beta.10 behavior.
