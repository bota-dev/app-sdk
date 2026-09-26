# Web Physical-Device Acceptance

This is the supervised release gate for the foreground Bota SDK for Web. It
must run in a supported desktop Chromium browser against one exact Bota Note or
Bota Pin with released foreground protocol support. Automated Playwright tests,
fake Bluetooth, simulator results, another platform's physical matrix, or a
prior SDK version cannot satisfy this gate.

The `1.2.0-beta.12` candidate has no selected browser/device session. Every row
below is therefore `NOT RUN`. Beta.7 is already public but has no accepted
physical matrix either. The release owner explicitly requested these beta
rollouts before production-device testing. This is a version-specific
exception to the prepublication gate, not physical-device acceptance; keep
each result open until its exact package is tested.

## Known browser identity blocker (2026-09-25)

A diagnostic run of the local `2.0.0-beta.2` Web candidate against a Bota Note
reached GATT connection and service discovery, then failed the serial read:
`SecurityError: getCharacteristic(s) called with blocklisted UUID`. The requested
characteristic was Device Information Serial Number String (`0x2A25`). The
[Web Bluetooth GATT blocklist](https://github.com/WebBluetoothCG/registries/blob/master/gatt_blocklist.txt)
excludes that standardized identifier for privacy reasons. Canonicalizing its
UUID does not make it accessible.

The approved source extension appends read-only Bota Identity service
`B07A0008-0000-1000-8000-00805F9B34FB`, serial characteristic
`B07A0008-0001-1000-8000-00805F9B34FB`, to firmware without changing old ATT
records. The Web transport maps shared serial reads to it; the Rust exact-SN
workflow and native transports are unchanged. Automated checks cover the
blocklist and exact identity. After the user flashed the Identity extension,
the 2026-09-25 Chrome run passed connection and snapshot serial verification.
The next failure was the shared decoder rejecting the real 24-byte capability
value `[1,2,24,0,127,3,0,0,0,4,0,4,228,1,44,0,1,0,0,0,44,0,0,0]`:
upload-context/recovery bits made flags `0x37f`, beyond its old bits 0–7 mask.
Rust codec and real-WASM snapshot regressions now cover that packet; the
canonical manifest/decoder recognizes bits 8/9 without loosening unknown-bit
validation or changing upload authorization. The rebuilt local packed artifact
(`SHA-256 bada46213b2f32aa345c818c42a25ddb7fc5424c0350e58aff27b6c0b432a6a3`)
then passed real Chrome connection and Refresh against serial `GDPPSBZJN6`.
The local Portal displayed firmware `1.0.18`, model `BOTA_DEV`, hardware `1.0`,
battery 100%, storage 116/7454 MB, zero pending recordings, Idle, and v2
Advertised. Fresh captures were 2026-09-25 20:32:49 and 20:33:12 America/Los_Angeles.
One earlier retry remained pending and was abandoned by reloading; this is not
evidence of bounded connection latency. This is read-only local integration
evidence, not published-package or production deployment acceptance. Reopen the
picker after upgrading so its service grant includes Identity. Do not bypass browser protections, substitute the
advertised name or browser device ID for the serial, or report automated fake-GATT
success as physical acceptance. This diagnostic is not a completed release matrix
and does not change the historical candidate results below. No recording,
provisioning, reset, or firmware-update operation was attempted.

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
source link or registry fallback. The checked consumer under
`tests/consumers/web-vite` is an automation fixture that installs fake
Bluetooth before page load. Never serve or modify it for physical acceptance.

First produce and verify the exact candidate tarball. This command remains
automated evidence only:

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/target/playwright-browsers"
npm run web:verify
```

Create a separate temporary physical host outside the repository and install
that exact tarball. This host uses the browser's real `navigator.bluetooth` and
contains no Playwright initialization or fake transport:

```bash
export APP_SDK_ROOT="$PWD"
export WEB_TARBALL="$APP_SDK_ROOT/target/web-release/bota.dev-web-sdk-1.2.0-beta.12.tgz"
export PHYSICAL_HOST="$(mktemp -d)/bota-web-physical-host"
npm create vite@8.3.0 "$PHYSICAL_HOST" -- --template vanilla-ts
cd "$PHYSICAL_HOST"
npm install "$WEB_TARBALL"
```

Copy the complete provider/client TypeScript block from
[`frameworks/web/README.md`](../../frameworks/web/README.md#create-a-client-and-provide-backend-boundaries)
to `src/sdk.ts`. It is type-checked as part of this documentation change and
implements every provider method. Before a supervised run, set
`window.BOTA_TEST_HOST_ORIGIN` to the approved lab host in the untracked local
`index.html`; the committed example uses only `https://example.invalid` and
cannot perform backend-authorized mutations by itself.

Replace the temporary host's `index.html` with this minimal real-Bluetooth UI:

```html
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Bota physical Web host</title></head>
  <body>
    <input id="organization" placeholder="organization ID">
    <input id="project" placeholder="project ID">
    <input id="user" placeholder="user ID">
    <input id="serial" placeholder="exact device serial">
    <button id="initialize">Initialize</button>
    <button id="connect">Connect picker</button>
    <button id="reconnect">Reconnect authorized device</button>
    <button id="snapshot">Read snapshot</button>
    <button id="disconnect">Disconnect</button>
    <pre id="result"></pre>
    <script>window.BOTA_TEST_HOST_ORIGIN = 'https://example.invalid'</script>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Replace `src/main.ts` with:

```ts
import { createExampleClient } from './sdk'

type Client = Awaited<ReturnType<typeof createExampleClient>>
declare global { interface Window { botaPhysicalClient?: Client } }

const input = (id: string): string => {
  const element = document.querySelector<HTMLInputElement>(`#${id}`)
  if (!element?.value) throw new Error(`Missing ${id}`)
  return element.value
}
const result = document.querySelector<HTMLPreElement>('#result')!
const show = (value: unknown): void => {
  result.textContent = JSON.stringify(value, (_, item) =>
    typeof item === 'bigint' ? item.toString() : item, 2)
}
const client = (): Client => {
  if (!window.botaPhysicalClient) throw new Error('Initialize first')
  return window.botaPhysicalClient
}

document.querySelector('#initialize')!.addEventListener('click', async () => {
  window.botaPhysicalClient = await createExampleClient({
    organizationId: input('organization'),
    projectId: input('project'),
    userId: input('user'),
  })
  show(client().devices.getCapabilities())
})
document.querySelector('#connect')!.addEventListener('click', async () => {
  show(await client().devices.connect({ expectedSerialNumber: input('serial') }))
})
document.querySelector('#reconnect')!.addEventListener('click', async () => {
  show(await client().devices.reconnect({ expectedSerialNumber: input('serial') }))
})
document.querySelector('#snapshot')!.addEventListener('click', async () => {
  show(await client().devices.readSnapshot())
})
document.querySelector('#disconnect')!.addEventListener('click', async () => {
  await client().devices.disconnect()
  show({ disconnected: true })
})
```

Run the physical host on loopback and open the printed URL in the supported
desktop Chromium browser:

```bash
npm run dev -- --host 127.0.0.1
```

The buttons exercise real picker/reconnect/snapshot behavior. The supervisor
executes later matrix operations through `window.botaPhysicalClient` in DevTools
using the exact calls in the Web integration guide, after reviewing each
state-changing input. Keep the page visible for every operation. Confirm the
installed package version and the source revision in
`target/web-release/web-package-files.json`, and record the browser's full
version; "Chromium" without a version is insufficient.

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
| 7 | Connection settings | Read current settings, write one reviewed reversible change, read it back, then restore and verify the original value | Device settings | `NOT RUN` |
| 8 | WiFi lifecycle | Scan, configure the reviewed test network, observe status/read subscription, disconnect, remove the subscription, and restore the initial WiFi state | WiFi credentials/state | `NOT RUN` |
| 9 | Recording start/stop | Exact host authority starts recording once and stops it once; stale/wrong authority is rejected without an unintended transition | Creates a disposable recording | `NOT RUN` |
| 10 | OTA, reboot, reconnect | Download progress is monotonic; size/SHA-256/CRC32 verify before device write; transfer completes; reboot reconnect uses only the exact saved device ID; firmware readback equals the reviewed target | Firmware update | `NOT RUN` |
| 11 | Device logs and removal | One subscription emits sanitized decoded lines; `remove()` unsubscribes; replay or later notifications produce no callback; no raw packet or private log text is committed | Diagnostics subscription | `NOT RUN` |
| 12 | Cancellation | Cancel one recording sync and one OTA operation at a reviewed recoverable point; late provider/GATT completions do not confirm, mutate, or publish completion; durable state is internally consistent | May leave resumable local/device state | `NOT RUN` |
| 13 | Reload recovery | Reload during a durable recording operation and OTA phase; resume validates tenant journal/checkpoint/blob, reconnects only the exact authorized device when required, and completes or safely refuses without name fallback | Resumes prior reviewed operations | `NOT RUN` |
| 14 | Remove-only deprovision | After every operation requiring device authorization has passed, the exact grant succeeds and backend/device state reflects non-destructive deprovisioning; no recording wipe or factory-reset claim occurs. If any earlier row must be repeated afterward, complete a supervised rebind and verify exact identity before continuing | Removes provisioning | `NOT RUN` |
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
candidate. Until then, Web physical acceptance remains open. The one-time
The beta.7 and beta.8 publication exceptions above do not turn a `NOT RUN` row into
`PASS` or authorize a later release with unresolved failures.
