# Apple Physical-Device Acceptance

The Apple physical suite is a supervised release gate. It never chooses a
device by display name. Each run requires an exact serial number and verifies
that serial after connecting before it performs a feature operation.

The suite is disabled by default. A normal `tools/apple/test-package.sh` run
must report every physical test as skipped before `BotaDeviceClient` is
configured, so CI and developer test runs do not open Bluetooth or mutate a
nearby device.

## Lab Preparation

Run the matrix once with a Bota Pin and once with a Bota Note. Use one selected
device at a time and record its firmware revision, Apple hardware, Apple OS,
test revision, and result in
`release/evidence/1.0.0-alpha.1-apple-facade.md`.

Required for every supervised run:

```bash
export BOTA_PHYSICAL_TESTS=1
export BOTA_DEVICE_SERIAL='<exact serial number>'
export BOTA_DEVICE_MODEL='bota_pin' # or bota_pin_4g / bota_note
```

Optional timing controls:

```bash
export BOTA_SCAN_TIMEOUT_MS=10000
export BOTA_OPERATION_TIMEOUT_SECONDS=600
```

Verify the default safety gate first:

```bash
env -u BOTA_PHYSICAL_TESTS \
  -u BOTA_DEVICE_SERIAL \
  -u BOTA_DEVICE_MODEL \
  tools/apple/test-package.sh --filter PhysicalDeviceTests
```

Expected: nine tests skipped, zero failures, and no Bluetooth prompt or device
activity.

## Non-Destructive Matrix

With the required variables set, run the baseline cases:

```bash
tools/apple/test-package.sh --filter PhysicalDeviceTests
```

This checks Bluetooth permission through client configuration, scan visibility,
serial-verified connection, app-instance restart reconnect, status decoding,
and device-log cleanup. Feature-changing cases remain skipped until their
individual gates and inputs are supplied.

Connection settings write:

```bash
BOTA_ALLOW_SETTINGS_WRITE=1 \
tools/apple/test-package.sh --filter PhysicalDeviceTests/testConnectionSettingsWrite
```

The Bota Note case writes WiFi and BLE only. The Pin case also includes
cellular. Both disable streaming for the test write.

Provisioning requires test-only backend material:

```bash
export BOTA_ALLOW_PROVISIONING=1
export BOTA_PROVISIONING_ENDPOINT='https://test.example.invalid/device'
export BOTA_PROVISIONING_TOKEN_BASE64='<base64 device token>'
export BOTA_PROVISIONING_MTU=180
tools/apple/test-package.sh --filter PhysicalDeviceTests/testProvisioning
```

OTA requires a reviewed firmware image and expected metadata:

```bash
export BOTA_ALLOW_OTA=1
export BOTA_FIRMWARE_URL='<test firmware URL>'
export BOTA_FIRMWARE_VERSION='<expected version>'
export BOTA_FIRMWARE_SIZE_BYTES='<decimal bytes>'
export BOTA_FIRMWARE_CRC32='<decimal or 0x-prefixed CRC32>'
export BOTA_FIRMWARE_DOWNLOAD_ID='<unique numeric ID>'
tools/apple/test-package.sh \
  --filter PhysicalDeviceTests/testFirmwareUpdateRebootReconnectAndReadback
```

The OTA case is accepted only when progress completes, the expected reboot is
reconnected through the SDK workflow, and status readback succeeds.

## Recording And Upload Ownership

The current transfer workflow confirms the completed recording to firmware,
which deletes that device-side file. Prepare a disposable recording and opt in
explicitly:

```bash
export BOTA_ALLOW_RECORDING_DELETE=1
export BOTA_RECORDING_UUID='<optional exact recording UUID>'
export BOTA_UPLOAD_ID='<opaque test upload ID>'
export BOTA_UPLOAD_DESTINATION_ID='<opaque test destination ID>'
tools/apple/test-package.sh \
  --filter PhysicalDeviceTests/testRecordingTransferAndUploadOwnership
```

The SDK receives a native file URL for the transfer and passes only the opaque
upload identifiers to the ownership workflow. Presigned URLs and credentials
must remain in the application host.

## Remove-Only Deprovision

Deprovision is not factory reset. It removes device provisioning without
authorizing the destructive reset workflow:

```bash
BOTA_ALLOW_DEPROVISION=1 \
BOTA_DEPROVISION_GRANT_BASE64='<nonce-bound deprovision grant>' \
tools/apple/test-package.sh --filter PhysicalDeviceTests/testRemoveOnlyDeprovision
```

The grant must be issued for the connected device's current BLE session nonce.
The test writes it before opcode `0x05` and requires a successful firmware
result.

Do not set `BOTA_ALLOW_DEPROVISION` and `BOTA_ALLOW_FACTORY_RESET` in the same
run.

## Authenticated Factory Reset

Factory reset deletes every recording on the physical device. Read the current
provisioning/reset design and obtain a command-bound backend grant before this
run. Execute it separately from every other case:

```bash
export BOTA_ALLOW_FACTORY_RESET=1
export BOTA_FACTORY_RESET_COMMAND_ID='<backend command ID>'
export BOTA_BINDING_GENERATION='<current decimal generation>'
export BOTA_FACTORY_RESET_NONCE_HEX='<connection-bound nonce>'
export BOTA_FACTORY_RESET_GRANT_BASE64='<command-bound grant>'
tools/apple/test-package.sh \
  --filter PhysicalDeviceTests/testAuthenticatedFactoryResetReceipt
```

The callback rejects a serial, command ID, binding generation, or nonce that
does not match the selected run. Acceptance requires the exact completion
receipt. A timeout, disconnect, unbind, or deprovision is not a reset receipt.

## Recording Evidence

For each command, preserve the complete test output and record:

- exact `git rev-parse HEAD`
- model and serial number (redact only in public copies)
- firmware revision before and after OTA
- Apple hardware and OS version
- test name and pass, fail, skip, or not-run result
- backend command ID and binding generation for reset, without the grant
- any unsupported model capability and its compatibility-matrix source

Do not change `physicalDeviceStatus` to `physical_device_verified` until both
required model runs and the separately gated reset receipt are reviewed.
