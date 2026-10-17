# React Native current connection ownership

October 17, 2026 — unpublished source correction after the qualified Find
candidate `c4a20f38`. Public beta.19 remains the immutable `7a4ff009` release.

The generated-JavaScript runtime owns one current BLE connection. Its existing
replacement path released the old link before connecting the next device, but
did not publish the existing disconnect notification to the compatibility
`DeviceManager`. The manager could consequently retain both devices. A status
read or disconnect addressed to the departed device could then invoke the
parameterless runtime operation against the new device.

An actual generated-core/runtime/manager fixture reproduces Pin-to-Note
replacement with both cached entries, a stale Pin status read on the Note port,
and a stale Pin disconnect that releases the Note. This source reproduction is
separate from the owner's physical observation of two cached entries; it does
not infer the cause of any earlier recording or upload failure.

## Correction and boundaries

The existing adapter replacement path now emits its existing disconnect event
only after successful old-link release, before starting the next Rust connection
workflow. The manager retires its old entry, callbacks and subscriptions through
its existing disconnect handler. A manager-owned connection attempt suppresses
rearming the departed device's automatic reconnect loop during that replacement.
Failed release still rejects without claiming disconnection or connecting the
next device.

Compatibility status/disconnect calls verify both peripheral ID and serial.
Disconnect verifies the same current cached connection again after awaiting
subscription release, before invoking the parameterless runtime disconnect.
This prevents an old request from targeting a replacement while its subscription
removal was pending. No new wire command, native capability, selection policy or
independent connection workflow is introduced. Rust still owns connection and
reconnect behavior; the generated core, installed version 1 OS ports, upload
journals, retained files and receipt-gated cleanup are unchanged.

## Requirement review

Basis: `internal-docs/device/Connection-Management.md` requires serial-strict
identity and one active selected connection, with serialized reconnect ownership.
The App SDK architecture assigns shared workflows to Rust and OS/facade
bookkeeping to the adapter. This correction restores that bookkeeping boundary.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Successful replacement retires the old manager entry before returning the next device | Real generated-core/runtime/manager tests cover both connect and reconnect, including a late old disconnect callback | matched in host tests |
| A stale target cannot read or disconnect the next device | Tests reject old ID/serial targets with no additional port IO; same-peripheral/different-serial replacement is covered | matched in host tests |
| Awaited subscription cleanup cannot retarget disconnect | Public manager/client fixture holds old removal while the next connection is remembered; the old disconnect refuses before parameterless disconnect | matched in host tests |
| Replacement cannot rearm the departed device's retry loop | Actual manager watchdog/auto-reconnect fixture observes no competing old reconnect | matched in host tests |
| Failed release is not reported as success | Actual adapter cleanup-failure fixture preserves the old entry, emits no successful disconnect and never starts the next connection | matched in host tests |
| Shared behavior and durable upload state remain unchanged | Compiler-free generated-core provenance, unchanged Rust/core and no queue/file/journal edits | matched in source checks |
| New exact hosted CI, package and physical behavior | Local source verification is below; hosted qualification and a new normal-app physical test remain separate | pending |

## Verification checkpoint

Seven focused ownership groups pass after the correction. Before the correction,
six groups fail and the existing failed-release preservation group passes. The
fixture explicitly joins watchdog disconnection during teardown; earlier private
logs preserve a fixture teardown rejection rather than attributing it to this
production correction.

All **540 RN tests** pass, including the seven new ownership groups. Normal
module/CommonJS/declaration builds, strict SDK TypeScript, Codegen,
compiler-free core provenance, package metadata and the 33-package license gate
pass. The first full run passed 539/540: its sole failure was the frozen vector's
Windows checkout line endings. Restoring the exact committed LF blob passes all
six vector checks and the full rerun, with no tracked vector change. Original
failure logs are preserved.

A separate actual runtime/manager audit holds a status read during disconnect
and attempts replacement at abort, read settlement and disconnect invocation.
All three schedules refuse replacement with `operation_in_progress`, join the old
disconnect, and never disconnect the next target. This is bounded race coverage,
not proof that every possible schedule is excluded. No additional production
policy is added for an unproven race.

Independent review and exact hosted CI/License remain required before integration;
candidate archive checks and a new normal-app physical test remain separate.
Local Windows checks do not replace native-platform CI.

The owner continues physical testing with the unchanged qualified `c4a20f38`
private package and a joined, freshly configured single-device owner. That
workaround is not physical acceptance of this source. Complete encrypted-v2
commitment, device cleanup and app OTA remain separate gates.
