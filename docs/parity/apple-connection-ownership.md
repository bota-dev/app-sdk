# Apple local connection ownership

Released in synchronized beta.15; see the
[publication evidence](../../release/evidence/2.0.0-beta.15-publication.md).
The dated source review below retains its original tests and hardware limits.

October 11, 2026: unpublished source correction. A peripheral connected to iOS
is not necessarily connected to this SDK's `CBCentralManager`. Apple requires
an application to call `connect` on a retrieved system-connected peripheral
before using it; see [system-connected peripherals](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager/retrieveconnectedperipherals(withservices:)).

Previously, `CoreBluetoothDriver.connect` returned success for any peripheral
whose system state was `connected`, minting a local connection identity even
without this central's `didConnect` callback. The SDK now reuses that shortcut
only when this central already owns a callback-confirmed connection. Otherwise
it calls `connect` and waits for the local callback. The existing dedicated
serial queue, service-filtered system retrieval, Rust serial verification and
peripheral operation gate remain authoritative.

`CoreBluetoothConnectionOwnership` holds the callback identity and pending
connect continuation on the driver's queue. Disconnect, failed connection and
Bluetooth loss invalidate ownership; Bluetooth loss also fails pending connect
requests. An already owned, still-connected peripheral retains its identity.
This does not forcibly disconnect another application's or another phone's
connection. Apple documents that [canceling a local connection](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager/cancelperipheralconnection(_:))
may leave the system's physical link active.

| Requirement | Evidence | Status |
| --- | --- | --- |
| System connection alone cannot authorize local SDK use | The extracted previous shortcut failed three ownership regressions with five assertions; the corrected callback-owned branch passes | Matched in source/native tests |
| Reuse an existing local connection without rotating identity | Ownership regression checks identity continuity and no second connect | Matched in native tests |
| Clear local ownership after disconnect/failure/Bluetooth loss | Regression checks local reconnect with a remaining system link, propagated failure and pending-connect settlement on Bluetooth loss | Matched in native tests |
| Acquire a retrieved system link and verify the exact device on a physical iPhone | Existing retrieval and serial-verification paths are preserved; a physical system-connected reproduction has not run with this correction | Unverified |

Run `swift test --package-path platforms/apple --scratch-path target/apple-swiftpm`
on the supported macOS host. The fresh complete suite passed 273 tests, including
the five new ownership cases; nine supervised physical tests skipped, with no
failures. This proves the Swift ownership logic and existing native suite,
not a CoreBluetooth radio session, a published package or an installed consumer.

The user reported restoring Bluetooth connectivity after releasing a lingering
system connection. They explicitly confirmed that the retained recording had
not yet uploaded. The previously installed private Demo 1.0.14 does not contain
this ownership correction. Upload, receipt, device cleanup and a physical
system-connected reconnect with the new source remain separate acceptance gates.

The private Demo 1.0.15(1) SE build passed signing, strict signature,
version/runtime and selected-phone provisioning checks. Its frozen public
beta.14 manifest/Rust payload is unchanged; its Swift source contains only the
two earlier upload corrections plus this driver/ownership correction. Public
package resolution was restored after the build. Installation and physical
acceptance are pending Mirroring's local Mac authentication; the build result
does not establish recovery of the user's lingering system connection.

The private 1.0.15(1) binary was subsequently installed in place on the selected
SE and verified through fresh native app metadata. Physical acceptance remains
unverified: Mirroring's restricted Mac authentication prompt needs local user
entry, and the optional USB UI presence runner stopped at locked-device
preflight before executing its test body. No upload or device cleanup ran in
this attempt.

A subsequent Mirroring run loaded the installed Demo and selected the intended
wearable through its normal dropdown. The detail page remained Connecting;
no verified SDK connection or successful native catalog was observed and no
sync was started. Its initial active selection had been a different serial,
so unscoped startup reconnect errors cannot prove a target-specific failure.
Mirroring closed during the read-only system-Bluetooth inspection and returned
to Mac authentication before the Bluetooth list was reached. Physical local
acquisition, the system connection's phone/client owner and upload acceptance
remain unverified.

After local Mac authentication, a fresh normal-UI scan in the installed
1.0.15 Demo ran for 30 seconds with Bluetooth ready. It discovered three nearby
peripherals and no Bota advertisements. Selecting the already paired target
then produced `device_not_found` during reconnect, with no SDK connection or
native capture catalog. The optional USB presence test separately failed its
Apple sharing-authentication handshake before the test body. These observations
do not exercise local ownership acquisition or establish which phone holds a
physical link; upload, receipt and cleanup remain unverified.

Later in that run the SDK verified the target serial and a fresh native catalog
returned the retained encrypted capture with its expected generation, length
and SHA-256. The SDK connection then dropped before sync. This proves a normal
physical connection/catalog with the installed correction, but does not prove
acquisition of a pre-existing system link or a stable upload session. The SE's
Settings Bluetooth list showed no Bota entry; that does not rule out an
unbonded SDK/system connection. Upload, receipt and cleanup remain unverified.

The user later identified the SE as the connected phone. Its Demo UI showed
Connected and a Sync Failed alert, without captured typed failure details.
The development launcher then reported the phone offline; Settings confirmed
disconnected Wi-Fi and Control Center's disabled new connections. Rejoining
the saved network allowed the project to load again. The target remained
Connecting afterward, with `device_not_found` and the sync row disabled.
The observed Wi-Fi failure does not establish the original upload error's
cause, and no successful upload/receipt/cleanup is qualified.

October 11 read-only follow-up supersedes the cloud-upload uncertainty for the
private SE candidate's original retained capture: latest owner revision 6 is
published over BLE with matching ciphertext evidence, verified plaintext and
the persisted/returned 336-byte receipt. Earlier expired-session reads were
historical. See [the upload review](v2-demo-apple.md). Fresh physical source
cleanup and acquisition of a pre-existing system connection remain unverified;
the current reconnect and scan cannot find the selected wearable.
