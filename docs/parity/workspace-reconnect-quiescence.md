# Awaitable reconnect pause

October 11, 2026 — unpublished React Native source correction.

A host workspace selector previously treated background reconnect work as an
active recording/upload. Removing that guard alone would let a connection from
the old workspace arrive after the host changed scope. The host now fences new
work, stops retries, waits for existing attempts, and checks/disconnects any late
connection before changing scope.

## SDK contract

`BotaClient.devices.pauseAutoReconnect(): Promise<void>` is additive. It invokes
the existing immediate retry stop and awaits the current serialized
`reconnectChain`, including successful or failed native attempts. A successful
late attempt remains visible in `getConnectedDevices()` for the host to inspect
and disconnect. Pausing alone neither disconnects nor proves that a device is idle.

The existing `disableAutoReconnect(): void` signature and behavior are preserved.
The compatibility test enumerates only the new method alongside all 80 frozen
exports and existing maintenance additions; historical baseline inventories are
unchanged. No native bridge, firmware command or package version changes here.

The host must exclude new manual reconnect calls and retry rearming while it
awaits the pause. It must retain recording/upload/OTA protection, check fresh
device activity, and preserve the current scope on unknown activity or disconnect
failure. Retry preference restoration must happen after releasing the host fence.
Calling `enableAutoReconnect` later resumes retries normally.

## Requirement review

Basis: the owner's idle workspace-switch requirement and graceful disconnection
contract: stop old retries without resetting, unbinding or deleting recordings.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Wait for already submitted native reconnects | Real `DeviceManager` regressions hold native success/failure promises; pause stays pending until settlement, then exposes the correct connected-device cache | matched in host tests |
| Preserve existing API | Frozen surface comparison includes the exact new method and leaves `disableAutoReconnect` unchanged | matched |
| Stop future automatic attempts | Existing synchronous disable path remains the first action; existing auto-reconnect lifecycle regressions remain green | matched in host tests |
| Host drains wrapper work and excludes retry rearming | Demo wrapper/auth regressions cover pending work, late arrival, failed stop/restoration, and the older-SDK fallback | matched in host tests |
| Physical host project switch during reconnect | Private Demo 1.0.15 on iPhone SE loaded this JavaScript correction and completed the normal project-picker switch, showing the destination checkmark and its main recordings list without the false activity alert | matched in this app session |
| Successful late native arrival and active-work refusal on hardware | Controlled SDK/host tests cover these races and guards; this physical session had unsuccessful background reconnects | unverified physically |
| Android physical behavior and public delivery | No publication or Android device test in this correction | unverified |

## Verification and delivery

The complete React Native package build/test passes **189 tests**, including API
compatibility and both reconnect settlement regressions. Demo passes **77**
workspace/navigation, firmware, connection settings, upload recovery, device
session and local-file privacy checks plus TypeScript.

The initial return-type change failed the frozen API gate and was replaced by
this additive method. A separate installed dependency mismatch was resolved with
the existing frozen lockfile; no dependency or lockfile change was needed.

The SE test used an isolated Metro snapshot of the published beta.14 source with
only `src/managers/DeviceManager.ts` replaced. Its SHA-256 is
`2b885adb99a5a314eeb5709ae6a97319e2e687fcbde91fb8c2bb51c6821fc4de`.
The installed native binary, package manifest and consuming app dependency pin
were unchanged. Published beta.14 does not have this method: hosts must retain
the pending-reconnect guard until they adopt a released SDK with the addition.
This project-selector result does not establish encrypted-upload commitment or
device cleanup acceptance.
