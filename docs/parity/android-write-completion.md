# Android characteristic write completion

## Failure and scope

An Android Demo OTA attempt on October 9, 2026 reported
`firmware BLE operation failed with code Some(-201)`. The phone log immediately
before it reported `writeCharacteristic() - prior command is not finished`.
Android status 201 is `ERROR_GATT_WRITE_REQUEST_BUSY`; the host bridge negates
platform errors before returning them to Rust. Raw logs remain private.

The platform adapter previously returned success as soon as a write without
response was accepted. The per-device queue consequently released before
Android's local write-completion callback, allowing another GATT command while
Android still considered the previous write active. A controlled framework test
reproduced premature completion against the original source. This establishes
the source defect; successful OTA on an updated installed app remains a separate
acceptance check.

Both response modes now register a completion waiter before issuing the write.
Only `onCharacteristicWrite` completes an accepted write. Immediate rejection
returns its original status without waiting for a callback. Cancellation of a
pending issued write closes that exact GATT session through the existing terminal
cleanup path. Android cannot cancel an individual issued write; releasing only
its waiter would permit overlapping retry or a stale callback to satisfy it.
An old GATT callback cannot complete a replacement generation.

This is native transport sequencing, with no new OTA wire format, retry loop,
delay, public API, firmware change, or JavaScript transport implementation.
The separate global-operation-lock and firmware-blob-read errors are outside
this correction.

## Contract and review

The App SDK radio/operation serialization design requires one ordered GATT queue
per connected device, with no competing native operations. The native-facades
design likewise serializes characteristic writes with discovery, reads, MTU and
CCCD work. Android documents a completion callback for characteristic writes,
including the API accepting `WRITE_TYPE_NO_RESPONSE`:
[BluetoothGatt.writeCharacteristic](https://developer.android.com/reference/android/bluetooth/BluetoothGatt#writeCharacteristic(android.bluetooth.BluetoothGattCharacteristic,%20byte[],%20int)).

| Requirement | Evidence | Status |
| --- | --- | --- |
| Accepted writes hold the queue until native completion | Framework regression withholds the first callback and attempts a second queued write; original source fails the completion assertion; corrected source passes on API 26/35 | Matched in simulated Android tests |
| Preserve immediate and callback failures | Rejection regression covers both modes; delayed second callback reports GATT 133; passes on API 26/35 | Matched in simulated Android tests |
| Cancel only the exact issued connection and reject stale completion | Framework regression cancels a pending write, reconnects, and injects the old callback during a replacement write; passes on API 26/35 | Matched in simulated Android tests |
| Preserve shared driver behavior | All 31 controlled GATT host/driver tests and 20 framework tests pass | Matched in automated tests |
| Installed Demo OTA succeeds | Requires rebuilt native SDK/app and physical version read-back | Unverified |

## Delivery limits

Published synchronized `2.0.0-beta.14` and existing native app binaries do not
contain this change. JavaScript updates cannot replace the native Android adapter.
Package publication, an Android app rebuild, installation and physical OTA
completion must be recorded separately. Host tests do not establish device
acceptance or explain the separate generic firmware file-read failure.

The complete local Android unit run passed 284 of 286 tests. Two existing
`EncryptedUploadV2TransferHostTest` cases fail both with this correction and with
the original production adapter restored: `successfulConfirmHandoffIsAtomicBeforeHostContinuation`
reports Windows `AccessDeniedException`; `disconnectDuringPostWriteCleanupSettlesCompletionBeforeClearingPoison`
times out. This comparison does not establish their deeper cause or a full-suite
pass. Local release lint cannot start the repository's Unix `build-native.sh`
through Windows Gradle. Exact-revision hosted CI and License Gate remain required;
none of these checks has been skipped or reported as passing.
