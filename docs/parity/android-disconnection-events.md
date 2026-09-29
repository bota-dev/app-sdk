# Android confirmed disconnection propagation

Status: unpublished source change; automated and physical validation pending.
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

## Design review

Basis: Android lifecycle and RN DeviceManager compatibility plans, architecture
native-transport ownership, and the observed beta.7 failure.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Loss without a status subscription | Native manager and RN adapter regressions | Implemented; execution pending |
| Invalidate verified state and presence | Exact-generation handler and registry/presence assertions | Implemented; execution pending |
| Preserve replacement connections | Stale-generation regression and runtime lease check | Implemented; execution pending |
| Reject loss during metadata reads | Transport identity recheck and controlled read regression | Implemented; execution pending |
| Observer teardown | Status closure and detach-settlement regression; RN stopAll cancels and joins | Implemented; execution pending |
| Public compatibility | Existing streams/events; no new public SDK symbols | Source review only |
| Builds and physical recovery | Matching candidate still required | Unverified |

Initial Windows Gradle attempts stalled before compilation during dependency
instrumentation. They establish no regression-test result. CI and License Gate
must pass at the exact pushed revision before merge or release.
