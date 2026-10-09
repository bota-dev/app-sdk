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

## Normal Preview build and reboot recovery — October 9

The owner's requested normal Demo Preview application was rebuilt from Demo
`910ec7c30484b4a1d3d02b22c795f98e9f0d9515` plus the local current/available
firmware display edit. SDK `ccffe760` differs from native executable source
`999896d` only in documentation. The private resolved AAR hash remains the
verified CI candidate above. The React Native facade remains beta.14.

The normal package `com.galaxysaillab.bota.demo.preview`, version `1.0.12`,
was built for arm64-v8a with embedded JavaScript and automatic updates disabled.
Typecheck, 15 focused Demo checks, release assembly/lint and APK signature
verification passed. APK SHA-256:
`152a0f52878d7a99fe9eccbf6329b03d1ba4d5d7f8d670e39fa1a76c8896f76e`.
Installation replaced the normal Preview identity; no new application was created.

The physical attempt passed transfer and verification, then failed in reboot
recovery at 15:08:59 Pacific. Android reported disconnect status 8 and the SDK
returned `firmware BLE operation failed with code Some(-8)`. The earlier `-201`
did not recur. The owner reports that toggling the phone's Bluetooth restored
connection and then reports Android OTA fixed. The owner subsequently clarified
that the active test is a GDP Note with the latest firmware; do not treat that
as independent Pin installed-version proof. These reports do not establish
fresh target-version read-back or automatic SDK recovery without the toggle.

The source reducer accepted `Disconnected` during `AwaitingReboot`, but Android's
lost notification stream arrived as `Failed` first. Also, one unsuccessful short
scan failed the child connection reducer before the outer two-minute deadline.
The correction permits transfer-status loss only after successful verification,
and retries transient discovery/connection failure after one second without
restarting the overall deadline or downloading/transferring again. Same-serial
verification and exact target-version read-back remain unchanged. Android already
closes the GATT object on confirmed disconnect; a persistent GATT leak has not
been independently established by the Bluetooth-toggle observation.

| Requirement | Evidence / verification | Status |
|---|---|---|
| Normal local Android build with write sequencing fix | Exact resolved AAR and signed installed APK; physical transfer/verification passed without `-201` | matched for this candidate |
| Expected reboot transport loss enters recovery | Regression reproduces post-verification `-8`; earlier stream loss must still fail | source verified; new native consumer pending |
| Wait for device within a bounded recovery window | Empty-scan retry regression preserves the original 120-second deadline | source verified; physical automatic recovery pending |
| Same device and installed target version | Existing serial/version workflow regression retained | source verified; independent physical read-back pending |
| Release old GATT without a phone radio toggle | Native confirmed-disconnect path closes GATT; owner needed radio toggle in this attempt | partial; automatic recovery pending |

This follow-up is unpublished source. The installed APK above does not yet
contain the reboot-recovery correction. Hosted CI/License, rebuilt consuming
APK and another supervised automatic reconnect test remain separate gates.

Local Rust formatting and workspace Clippy passed. The focused OTA suite passes
all ten tests, including the two initially failing regressions and the negative
pre-verification case. The wider workspace run passed 225 tests in 40 groups
before Windows Application Control blocked the `xtask` test executable with
OS error 4551. That executable was not run; a full local workspace pass is not
claimed. Required exact-revision hosted CI must cover this remaining gate.

For the next isolated arm64 consumer, the unchanged JNI/Android classes from the
verified candidate were retained and only `jni/arm64-v8a/libbota_device_sdk_ffi.so`
was rebuilt from this source with the pinned API-26 NDK. All other AAR entries
match. The exported symbols remain identical and ELF LOAD alignment is 16 KiB.
This mixed-ABI private AAR is for the arm64 test app only, not publication:
SHA-256 `dfffe9cd31b627818dbc62f4d1607c572b0b71969fd73085a44237e436b0705b`;
rebuilt core SHA-256
`f543f1a1121016578dd091557bdac7b2aa8486e543d66889b97e6095dcbaf789`.
