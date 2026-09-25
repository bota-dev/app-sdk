# Native Device Diagnostics

Apple and Android expose durable device diagnostic reads and explicit accepted-ID
acknowledgements through the existing `DeviceLogManager` (`client.logs`).
These APIs do not upload diagnostics or decide whether a backend accepted them.

## Public API

```swift
func readDiagnosticEvents(_ device: ConnectedDevice) async throws -> DeviceDiagnosticsBatch
func acknowledgeDiagnosticEvents(_ device: ConnectedDevice, acceptedEventIds: [String]) async throws
```

```kotlin
suspend fun readDiagnosticEvents(device: ConnectedDevice): DeviceDiagnosticsBatch
suspend fun acknowledgeDiagnosticEvents(device: ConnectedDevice, acceptedEventIds: List<String>)
```

The public model names and camelCase properties match on both platforms:

| Model | Properties |
| --- | --- |
| `DeviceDiagnosticsBatch` | `schemaVersion`, `events` |
| `DeviceDiagnosticEvent` | `eventId`, `eventType`, `reasonCode`, `uptimeMs`, `signature`, `firmwareBuildId`, `subsystem`, `stateBeforeEvent`, optional `report` |
| `DeviceDiagnosticReport` | `fault`, `execution`, optional `runtime`, optional `breadcrumbs` |
| `DeviceDiagnosticFault` | `cpuId`, `cpuEmu`, `coreEmu`, `hsbEmu`, `audioEmu`, `wirelessEmu` |
| `DeviceDiagnosticExecution` | optional `task`, `reti`, `rets`; `pcTrace` |
| `DeviceDiagnosticRuntime` | optional `heapFreeBytes`, `taskStackRemainingBytes` |
| `DeviceDiagnosticBreadcrumb` | `deltaMs`, `code`, `arg0` |

IDs and signatures remain canonical 16-character lowercase hexadecimal strings.
Firmware build IDs, exception registers, and normalized execution addresses remain
strings from Rust. Event types, reasons, subsystem, state, and breadcrumb codes are
strings, preserving the complete maintenance contract. `uptimeMs` and runtime byte
counts are `UInt32` in Swift and `UInt` in Kotlin. Breadcrumb numbers are signed
`Int32` in Swift and `Int` in Kotlin; `cpuId` and `schemaVersion` are `Int` on both.
Absent reports, runtime values, and breadcrumbs are not replaced with zero values.

## Protocol And Ownership

Rust owns decoding and command encoding through typed C ABI kinds `0x0525` and
`0x0526`; see [Diagnostics Codec](diagnostics-codec.md). Native mappers group typed
event/report fields without parsing BLE bytes or using serialized JSON as an ABI.
Each read resets the engine-owned decoder before LIST and on terminal cleanup.

Reads subscribe to diagnostics data (`0007/0002`) before writing LIST to control
(`0007/0001`). They require a complete END batch, have a 30-second operation
deadline, and unsubscribe on success, transport failure, malformed data, timeout,
cancellation, and manager teardown. Android installs its flow collector before
LIST, including when the host flow is unbuffered. Native I/O must honor task or
coroutine cancellation; teardown joins outstanding native cleanup.

Logs, reads, and acknowledgements share one manager owner and the existing runtime
operation coordinator. Ownership includes pending log startup and cancellation
settlement. Failed unsubscribe or log cancellation retains ownership rather than
allowing another operation to reuse possibly active diagnostics characteristics.
Apple drains both timeout/read task results and gives cleanup failure precedence:
a timeout, caller cancellation, or `stop()` cannot hide a later failed unsubscribe
and accidentally release the retained owner.
`stop()` cancels and joins the current operation; destroy detaches the manager.
Cleanup captures its original runtime and cannot release a replacement owner's
operation ID. Replacing an attached runtime cancels its old operation before LIST.
The connection registry assigns a new opaque generation on each set/clear.
Diagnostics capture that generation and reject replacements even when the
peripheral ID and serial are unchanged. Reads recheck after subscription and
before accepting data; acknowledgements recheck between writes. Cleanup skips
unsubscribe after its connection generation has ended, so it cannot target a
replacement connection. Existing unrelated registry APIs and reconnect policies
are unchanged; the shared operation owner remains held through cleanup.

Acknowledgement encodes and validates every supplied ID through Rust before the
first write. Only explicitly supplied accepted IDs are sent, in order. A read
never automatically acknowledges events. An empty accepted list writes nothing.
If a transport write fails, later IDs are not sent; the API does not claim a
transactional multi-ID acknowledgement.

Both platforms check native authorization and the current verified connection
before device work. Apple refreshes its existing Bluetooth authorization check
through the runtime policy hook; Android uses the existing operation authorizer.

## Verification

Verified on 2026-09-24: the unfiltered Apple suite passed 226 tests with nine
physical tests skipped and zero failures. Final focused tests passed on both
platforms (17 Apple; 13 Android, including existing log tests). Two Android
instrumentation codec tests passed on API 35 with freshly rebuilt Rust/JNI
artifacts. The Android release owner runs the final unfiltered debug/release,
lint, assembly, and local-publication gates after native source freeze.

- Native behavior tests cover subscribe-before-LIST, all-ID prevalidation,
  timeout, cancellation, teardown, runtime replacement during subscription,
  pending log startup, shared operation exclusion, and failed cleanup ownership.
  Same-ID/serial replacement regressions cover subscription and ACK boundaries.
  Apple combined regressions retain manager and runtime ownership when timeout,
  caller cancellation, or `stop()` is followed by failed unsubscribe.
- Typed mapper tests cover complete reports, signed breadcrumb extremes,
  unsigned numeric maxima, exact IDs, and sparse events without field shifting.
- Apple real-ABI tests exercise LIST/ACK validation, decoder reset, and empty END.
- Android `DeviceDiagnosticsCodecTest` runs on API 35 against freshly built Rust
  and JNI artifacts and covers LIST/ACK, complete chunked no-report assembly,
  reset, and incomplete-END rejection.

These automated checks are not physical-device or firmware acceptance evidence.
RN, Flutter, Web, release metadata, and encrypted-upload parity are separate work.
