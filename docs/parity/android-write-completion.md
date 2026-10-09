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
| Build and launch a local Android consumer containing the correction | Demo release assembly/lint, APK signature and actual Gradle-resolved SDK AAR hash verified; separate app installed, launched and signed in on Android 16 | Matched for this local candidate |
| Installed Demo OTA succeeds | Requires rebuilt native SDK/app and physical version read-back | Unverified |

## Delivery limits

Published synchronized `2.0.0-beta.14` and the existing store/Preview app binaries do not
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
through Windows Gradle. These are local Windows limitations, not skipped gates:
[CI run 37976315980](https://github.com/bota-dev/app-sdk/actions/runs/37976315980)
and [License Gate 37976316074](https://github.com/bota-dev/app-sdk/actions/runs/37976316074)
both passed for `999896d9784e45ae5ac0e5c029e8a6e46696ea54`. All eight CI jobs
passed, including the complete Android unit/lint, native consumer and API 26/35
checks and final release-candidate inventory.

The private Android CI candidate AAR has SHA-256
`5b0bbc74d8e15917e3938aa530a30311d437ff922cce98a465995be9a1a56e73`.
Its release manifest names the exact source revision above; all supplied SHA-256
files were checked before constructing the local Demo test app. The candidate
uses the existing version label only in an isolated local Maven repository;
published `2.0.0-beta.14` remains unchanged. Physical OTA acceptance is pending.

## Local Demo candidate — October 9, 2026

An isolated archive of Demo `fb024f9b5a16006682faf6a97707b2ac1baa4a6e`
was built with Node 22.23.2, Gradle 9.3.1 and the verified native SDK candidate.
The published React Native facade remains `2.0.0-beta.14`; only the native Maven
dependency was replaced in this private build. A component-filtered Gradle
artifact check confirmed the resolved AAR's SHA-256 matches the CI artifact
above. This is not a package or app-store release.

`assembleRelease`, including `lintVitalRelease`, passed. The final APK is a normal
release build with embedded JavaScript and automatic updates disabled. Its
separate application ID is `com.galaxysaillab.bota.demo.preview.otalab`, display
name **Bota Demo OTA Test**, and version `1.0.12-ota.999896d`. The existing Preview
app remains installed. APK SHA-256:
`e5dcd5485fad862a18027f9716036f29102598821474d2b0f81d36510f4fa8d4`.

Installation, launch and test-account sign-in succeeded on the connected Samsung
Android 16 phone; the captured candidate launch log contains no fatal exception
or fatal signal. This does not establish successful firmware download, BLE
transfer, reboot or installed-version confirmation. No firmware update was
started from the candidate. The account selected a different default device;
candidate Bluetooth was paused while the owner confirms the intended target.
Physical OTA acceptance remains **unverified**. Raw logs, APK and provenance are
kept outside Git.
