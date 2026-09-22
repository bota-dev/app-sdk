# Web Physical-Device Acceptance

This is the supervised release gate for the foreground Bota SDK for Web. It
must run in a supported desktop Chromium browser against one exact Bota Note or
Bota Pin with released foreground protocol support. Automated Playwright tests,
fake Bluetooth, simulator results, another platform's physical matrix, or a
prior SDK version cannot satisfy this gate.

The `1.2.0-beta.1` candidate has no selected browser/device session. Every row
below is therefore `NOT RUN`, and release remains `BLOCKED`.

## Safety boundary

Before touching a device:

1. Select one test tenant and one exact device serial from the authenticated
   backend record. Do not select by advertised name.
2. Confirm the device model and firmware support every row that will run.
3. Use a disposable recording and a reviewed test WiFi network. Preserve the
   original connection settings and WiFi state for restoration.
4. Obtain operation-scoped test backend material for provisioning,
   deprovisioning, recording upload/control, and OTA. Never paste credentials,
   grants, tokens, signed documents, presigned URLs, headers, receipts, WiFi
   credentials, recording content, or device logs into committed evidence.
5. Provisioning, deprovisioning, settings writes, WiFi changes, recording
   control, recording confirmation, and OTA are state-changing. The supervisor
   must approve each relevant row immediately before it runs.
6. Deprovision is remove-only and non-destructive. Authenticated factory reset
   is not supported by the Web candidate and must not be attempted through this
   matrix.

Stop immediately on serial mismatch, unexpected firmware capability, an
unreviewed state-changing prompt, ambiguous cloud completion, a second device
appearing as the reconnect target, or any request to expose secret material.

## Candidate preparation

Use a clean checkout of the exact candidate revision. Build and install the
same packed artifact verified by the release gate; do not use a workspace
source link or registry fallback.

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/target/playwright-browsers"
npm run web:verify
```

Serve the checked consumer from HTTPS or loopback, confirm the package version
and source revision shown by `target/web-release/web-package-files.json`, and
keep the page visible for every operation. Record the browser's full version;
"Chromium" without a version is insufficient.

## Run metadata

Complete this table in the release evidence before changing any result:

| Field | Required value for this run |
|---|---|
| Date and timezone | `NOT RUN` |
| Reviewer/operator | `NOT RUN` |
| Candidate Git revision | `NOT RUN` |
| Packed tarball SHA-256 | `NOT RUN` |
| Browser and full version | `NOT RUN` |
| Host OS and version | `NOT RUN` |
| Device model | `NOT RUN` |
| Exact serial | `NOT RUN` (redact only in the public copy after review) |
| Firmware before run | `NOT RUN` |
| Firmware after OTA | `NOT RUN` |
| Test tenant/evidence ID | `NOT RUN` |

Private lab output may contain the exact serial and internal request IDs. The
public release evidence uses a reviewed redaction or opaque evidence ID and
must never contain provider secrets or recording/log content.

## Supervised matrix

Run in order unless a recovery case explicitly requires reload or disconnect.
For every row, record `PASS`, `FAIL`, `BLOCKED`, or `NOT RUN`, the timestamp,
and a sanitized evidence reference. A conditional row may be `NOT APPLICABLE`
only with the fresh firmware capability value and reviewer disposition.

| # | Case | Acceptance criteria | State change | Current result |
|---:|---|---|---|---|
| 1 | Picker and exact identity | A trusted click opens the picker; the selected device is published only after the expected Device Information serial matches; a deliberate wrong serial fails and disconnects | Browser permission only | `NOT RUN` |
| 2 | Authorized reconnect | After disconnect/reload, `reconnect()` uses `getDevices()`, selects only the saved browser device ID, opens no picker, and re-verifies the exact serial | No | `NOT RUN` |
| 3 | Fresh snapshot | Identity, status, and capabilities are read from the exact connection; serial is re-verified and values are plausible for the selected device | No | `NOT RUN` |
| 4 | Legacy recording sync | A disposable legacy recording lists, transfers into tenant-scoped storage, uploads through the host destination, reaches durable cloud completion, then and only then receives device confirmation | Deletes the disposable device recording after confirmation | `NOT RUN` |
| 5 | Encrypted Upload v2 | When freshly advertised, ciphertext transfers/resumes, staged bytes and manifest verify, cloud completion returns the exact receipt, and confirmation follows; if not advertised, record reviewed `NOT APPLICABLE` without attempting START | Deletes the disposable device recording after exact receipt confirmation | `NOT RUN` |
| 6 | Provisioning close-loop | Exact nonce/public key/serial/attempt context reaches the provider; device success is confirmed to the backend; a separately prepared failure path aborts without claiming a completed bind | Binding/provisioning | `NOT RUN` |
| 7 | Remove-only deprovision | Exact grant succeeds and the backend/device reflect non-destructive deprovisioning; no recording wipe or factory-reset claim occurs | Removes provisioning | `NOT RUN` |
| 8 | Connection settings | Read current settings, write one reviewed reversible change, read it back, then restore and verify the original value | Device settings | `NOT RUN` |
| 9 | WiFi lifecycle | Scan, configure the reviewed test network, observe status/read subscription, disconnect, remove the subscription, and restore the initial WiFi state | WiFi credentials/state | `NOT RUN` |
| 10 | Recording start/stop | Exact host authority starts recording once and stops it once; stale/wrong authority is rejected without an unintended transition | Creates a disposable recording | `NOT RUN` |
| 11 | OTA, reboot, reconnect | Download progress is monotonic; size/SHA-256/CRC32 verify before device write; transfer completes; reboot reconnect uses only the exact saved device ID; firmware readback equals the reviewed target | Firmware update | `NOT RUN` |
| 12 | Device logs and removal | One subscription emits sanitized decoded lines; `remove()` unsubscribes; replay or later notifications produce no callback; no raw packet or private log text is committed | Diagnostics subscription | `NOT RUN` |
| 13 | Cancellation | Cancel one recording sync and one OTA operation at a reviewed recoverable point; late provider/GATT completions do not confirm, mutate, or publish completion; durable state is internally consistent | May leave resumable local/device state | `NOT RUN` |
| 14 | Reload recovery | Reload during a durable recording operation and OTA phase; resume validates tenant journal/checkpoint/blob, reconnects only the exact authorized device when required, and completes or safely refuses without name fallback | Resumes prior reviewed operations | `NOT RUN` |
| 15 | Logout cleanup | `destroy()` settles all owners/subscriptions and disconnects once; subsequent `clearPersistedData()` removes only the test tenant namespace and performs no BLE work | Deletes test tenant browser state | `NOT RUN` |

## Evidence capture

For each row preserve, outside the public repository when sensitive:

- timestamped browser console and application result with secret fields
  redacted;
- candidate revision, package tarball SHA-256, browser/OS, model, exact serial,
  and firmware;
- backend/cloud completion evidence by opaque request or evidence ID only;
- before/after settings, WiFi, binding, recording, and firmware state;
- cancellation/reload phase and the exact observed recovery result;
- reviewer disposition for any conditional or failed row.

Do not record request URLs, headers, grants, tokens, receipts, WiFi credentials,
recording bytes/content, or device-log content in the public evidence.

## Release decision

The Web physical gate passes only when every required row is `PASS`, every
conditional `NOT APPLICABLE` disposition is reviewed, the device is restored
to its intended final state, and the evidence references the exact release
candidate. Any `NOT RUN`, `FAIL`, or unresolved `BLOCKED` row keeps the
synchronized beta release `BLOCKED`.
