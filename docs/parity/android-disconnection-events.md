# Android confirmed disconnection propagation

Status: unpublished source change with passing automated validation at `9acff65`.
Physical-device results and final-revision checks are maintained in
[PR #22](https://github.com/bota-dev/app-sdk/pull/22); the CI evidence below does
not establish hardware acceptance or publication.
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
authorize upload fallback, change firmware, or publish a new package. Apps clear
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
result in PR #22. Radio-off evidence must not be generalized to out-of-range,
background, other devices, or end-to-end RN/Flutter UI behavior. Public examples
remain pinned to released beta.7 until a new SDK is published and adopted.
