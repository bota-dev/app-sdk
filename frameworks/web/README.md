# Bota SDK for Web

`@bota.dev/web-app-sdk` is the foreground browser distribution of the Bota App
SDK. It combines Web Bluetooth and tenant-scoped browser storage with the shared
Rust core compiled to WebAssembly. Rust owns protocol sequencing, integrity,
checkpoints, and stable workflow errors; the application owns authentication,
backend calls, user consent, and presentation.

Historical `@bota.dev/web-sdk@1.2.0-beta.7` is public. The renamed
`2.0.0-beta.0` candidate retains the foreground implementation; publication
is pending and physical-device acceptance remains open. Remove the old
dependency before adding its replacement. Storage namespaces do not change.

## Install

After the synchronized candidate is published, pin its exact version:

```bash
npm install --save-exact @bota.dev/web-app-sdk@2.0.0-beta.0
```

Use a secure context in a desktop Chromium browser with Web Bluetooth. The
initial `connect()` call must run directly from a user gesture because it opens
the browser picker. A previously authorized exact device may be reconnected
without a picker only when `navigator.bluetooth.getDevices()` is available.

## Create a client and provide backend boundaries

Read-only connect and snapshot use require no storage or provider. Durable or
backend-authorized workflows require a non-empty tenant namespace and the
applicable host provider. A custom storage adapter must expose the exact same
namespace.

```ts
import type {
  EncryptedUploadV2Material,
  EncryptedUploadV2ProviderContext,
  FirmwareDownloadProvider,
  LegacyUploadContext,
  ProvisioningProvider,
  RecordingControlProvider,
  RecordingUploadProvider,
  UploadRequestTemplate,
} from '@bota.dev/web-app-sdk'
import { BotaDeviceClient } from '@bota.dev/web-app-sdk'

declare global {
  interface Window {
    BOTA_TEST_HOST_ORIGIN?: string
  }
}

const HOST_ORIGIN = window.BOTA_TEST_HOST_ORIGIN ?? 'https://example.invalid'

function encodeBytes(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

async function postHost<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(new URL(path, HOST_ORIGIN), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) throw new Error(`Host callback failed: ${response.status}`)
  if (response.status === 204) return undefined as T
  return await response.json() as T
}

function uploadRequest(response: {
  url: string
  headers: Record<string, string>
}): UploadRequestTemplate {
  return { method: 'PUT', url: response.url, headers: response.headers }
}

function legacyBody(context: LegacyUploadContext): Record<string, unknown> {
  return {
    operationId: context.operationId,
    serialNumber: context.serialNumber,
    recordingUuid: context.recording.uuid,
    sizeBytes: context.sizeBytes.toString(),
    plaintextSha256Hex: context.plaintextSha256Hex,
    stagedBodySha256Hex: context.stagedBodySha256Hex,
    encrypted: context.encrypted,
  }
}

function v2Evidence(
  evidence: Parameters<EncryptedUploadV2Material['stagingRequest']>[0],
): Record<string, unknown> {
  return {
    ciphertextLength: evidence.ciphertextLength.toString(),
    ciphertextSha256Base64: encodeBytes(evidence.ciphertextSha256),
    manifestLength: evidence.manifestLength,
    manifestSha256Base64: encodeBytes(evidence.manifestSha256),
    blockCount: evidence.blockCount,
  }
}

const provisioning: ProvisioningProvider = {
  async prepare(context) {
    const response = await postHost<{
      materialId: string
      apiEndpointBase64: string
      deviceTokenBase64: string
      mtu: number
    }>('/sdk/provisioning/prepare', {
      attemptId: context.attemptId,
      materialId: context.materialId,
      serialNumber: context.serialNumber,
      nonceBase64: encodeBytes(context.nonce),
      devicePublicKeyBase64: encodeBytes(context.devicePublicKey),
    }, context.signal)
    return {
      materialId: response.materialId,
      apiEndpoint: decodeBytes(response.apiEndpointBase64),
      deviceToken: decodeBytes(response.deviceTokenBase64),
      mtu: response.mtu,
    }
  },
  async confirm(context) {
    await postHost<void>('/sdk/provisioning/confirm', {
      attemptId: context.attemptId,
      serialNumber: context.serialNumber,
    }, context.signal)
  },
  async abort(context) {
    await postHost<void>('/sdk/provisioning/abort', {
      attemptId: context.attemptId,
      serialNumber: context.serialNumber,
      reason: context.reason,
    }, context.signal)
  },
}

const recordingControl: RecordingControlProvider = {
  async prepare(context) {
    const response = await postHost<{ grantBase64: string }>(
      '/sdk/recording-control/prepare',
      {
        operationId: context.operationId,
        serialNumber: context.serialNumber,
        action: context.action,
        authorityId: context.authorityId,
      },
      context.signal,
    )
    return { grant: decodeBytes(response.grantBase64) }
  },
}

const firmwareDownload: FirmwareDownloadProvider = {
  async resolve(context) {
    const response = await postHost<{
      url: string
      headers: Record<string, string>
    }>('/sdk/firmware/resolve', {
      operationId: context.operationId,
      serialNumber: context.serialNumber,
      image: context.image,
    }, context.signal)
    return { method: 'GET', url: response.url, headers: response.headers }
  },
}

const recordingUpload: RecordingUploadProvider = {
  async prepareLegacyUpload(context) {
    const response = await postHost<{
      uploadId: string
      request: { url: string; headers: Record<string, string> }
    }>(
      '/sdk/recordings/legacy/prepare',
      legacyBody(context),
      context.signal,
    )
    return { uploadId: response.uploadId, request: uploadRequest(response.request) }
  },
  async completeLegacyUpload(context) {
    return await postHost<{ cloudCompletionId: string }>(
      '/sdk/recordings/legacy/complete',
      { ...legacyBody(context), uploadId: context.uploadId },
      context.signal,
    )
  },
  async reconcileLegacyUpload(context) {
    return await postHost<
      | { state: 'not_uploaded' }
      | { state: 'cloud_completed'; cloudCompletionId: string }
    >('/sdk/recordings/legacy/reconcile', {
      ...legacyBody(context),
      uploadId: context.uploadId,
    }, context.signal)
  },
  async prepareEncryptedUploadV2(context: EncryptedUploadV2ProviderContext) {
    const response = await postHost<{
      materialId: string
      recordingId: string
      uploadSessionId: string
      ownerRevision: number
      policy: 'legacy_allowed' | 'v2_preferred' | 'v2_required'
      authorizationBase64: string
    }>('/sdk/recordings/v2/prepare', {
      operationId: context.operationId,
      serialNumber: context.serialNumber,
      recording: {
        uuid: context.recording.uuid,
        generation: context.recording.generation,
        storageFormat: context.recording.storageFormat,
        ciphertextLength: context.recording.ciphertextLength.toString(),
        ciphertextSha256Base64: encodeBytes(context.recording.ciphertextSha256),
      },
      capability: {
        rawValueBase64: encodeBytes(context.capability.rawValue),
        sha256Base64: encodeBytes(context.capability.sha256),
        decoded: context.capability.decoded,
      },
      checkpoint: context.checkpoint && {
        uploadSessionId: context.checkpoint.uploadSessionId,
        ownerRevision: context.checkpoint.ownerRevision,
        checkpointRevision: context.checkpoint.checkpointRevision,
        nextCiphertextOffset: context.checkpoint.nextCiphertextOffset.toString(),
        prefixSha256Base64: encodeBytes(context.checkpoint.prefixSha256),
        transportSessionId: context.checkpoint.transportSessionId.toString(),
        sinkId: context.checkpoint.sinkId,
        windowPackets: context.checkpoint.windowPackets,
        dataPayloadBytes: context.checkpoint.dataPayloadBytes,
      },
    }, context.signal)
    const materialId = response.materialId
    return {
      ...response,
      authorization: decodeBytes(response.authorizationBase64),
      async stagingRequest(evidence, signal) {
        const request = await postHost<{
          url: string
          headers: Record<string, string>
        }>('/sdk/recordings/v2/staging-request', {
          materialId,
          evidence: v2Evidence(evidence),
        }, signal)
        return uploadRequest(request)
      },
      async submitManifest(manifest, evidence, signal) {
        await postHost<void>('/sdk/recordings/v2/manifest', {
          materialId,
          manifestBase64: encodeBytes(manifest),
          evidence: v2Evidence(evidence),
        }, signal)
      },
      async finalize(evidence, signal) {
        await postHost<void>('/sdk/recordings/v2/finalize', {
          materialId,
          evidence: v2Evidence(evidence),
        }, signal)
      },
      async completionReceipt(evidence, signal) {
        const receipt = await postHost<{ receiptBase64: string }>(
          '/sdk/recordings/v2/receipt',
          { materialId, evidence: v2Evidence(evidence) },
          signal,
        )
        return decodeBytes(receipt.receiptBase64)
      },
      async cancel(signal) {
        await postHost<void>(
          '/sdk/recordings/v2/cancel',
          { materialId },
          signal,
        )
      },
    }
  },
}

export async function createExampleClient(tenant: {
  organizationId: string
  projectId: string
  userId: string
}) {
  return await BotaDeviceClient.create({
    storageNamespace:
      `${tenant.organizationId}:${tenant.projectId}:${tenant.userId}`,
    providers: {
      provisioning,
      recordingUpload,
      recordingControl,
      firmwareDownload,
    },
  })
}
```

Those application-owned adapters have these exact responsibilities:

| Provider | Application responsibility | SDK boundary |
|---|---|---|
| `provisioning` | Prepare opaque material for the exact serial, nonce, device public key, and attempt; confirm physical success or abort failure | Material is operation-bound, volatile, and never logged or persisted by the SDK |
| `recordingUpload` | Resolve short-lived object-storage requests, reconcile ambiguous legacy uploads, complete cloud processing, and issue exact v2 material/receipt | The SDK stages verified bytes, uploads through the returned request, and confirms the device only after durable cloud completion |
| `recordingControl` | Exchange the serial, action, authority ID, and operation ID for an exact grant | The SDK cannot mint, widen, or reuse a grant for another action |
| `firmwareDownload` | Resolve stable image identity to a fresh operation-scoped HTTPS `GET` URL and headers | URL and headers stay memory-only; the SDK verifies size, SHA-256, and CRC32 before device mutation |

Implement these providers in the application or its backend-client layer. Do
not put long-lived API credentials, decryption keys, production endpoints, or
private signing material in browser code. A provider may call an authenticated
application endpoint such as `https://example.invalid/sdk/provisioning/prepare`;
the SDK itself never calls the Bota API implicitly. Provider failures must fail
closed, and provider implementations must not log returned grants, tokens,
signed documents, presigned URLs, headers, WiFi credentials, receipts, or
recording content. Every provider callback receives an operation-scoped
`AbortSignal`; pass it to application I/O. On cancellation the SDK stops
waiting, observes late settlement, and ignores late results. The SDK sends
operation-scoped upload and firmware requests
with redirects disabled; providers must return the exact final HTTPS target
rather than a redirecting URL.

Create one client for the signed-in tenant and keep it for the page lifetime:

```ts
const bota = await createExampleClient({ organizationId, projectId, userId })
```

## Picker connection, reconnect, and snapshot

The expected serial must come from the authenticated application device record.
An advertised Bluetooth name is display/filter metadata only.

```ts
connectButton.addEventListener('click', async () => {
  const device = await bota.devices.connect({
    expectedSerialNumber: activeDevice.serialNumber,
  })
  console.log(device.serialNumber)
})

// Use after a disconnect or reload. This never opens the picker or probes by name.
const reconnected = await bota.devices.reconnect({
  expectedSerialNumber: activeDevice.serialNumber,
})

const snapshot = await bota.devices.readSnapshot()
console.log(reconnected.serialNumber, snapshot.status.batteryPercent)
```

`connect()` publishes a device only after Device Information serial verification.
`reconnect()` enumerates previously authorized devices, selects only the saved
browser device ID, waits for prior notification teardown, and verifies the
serial again. `readSnapshot()` repeats that verification before returning fresh
identity, status, and capability values.

## Recording list and sync

```ts
const recordings = await bota.recordings.list()
const recording = recordings[0]

if (recording) {
  const profile = recording.encryptedUploadV2
    ? 'encrypted_upload_v2'
    : 'legacy'

  const result = await bota.recordings.sync(recording, {
    profile,
    onProgress: ({ phase, completedBytes, totalBytes }) => {
      renderRecordingProgress(phase, completedBytes, totalBytes)
    },
  })

  console.log(result.operationId, result.cloudCompletionId)
}
```

Encrypted Upload v2 is selected only from a fresh firmware capability read and
matching provider material; firmware version strings never enable it. The
ciphertext remains ciphertext in OPFS and through the staging upload, and
decryption keys never enter the SDK. Legacy plaintext is tenant-scoped and
removed after confirmed upload. Both paths send device confirmation only after
durable cloud completion.

Use `listPendingOperations()`, `resume(operationId)`,
`cancel(operationId)`, and recovery-only `confirm(operationId)` for durable
operations. `confirm()` is not an arbitrary delete API: it requires a journal
that proves cloud completion and exact confirmation material.

## Provisioning, settings, WiFi, and recording control

```ts
await bota.provisioning.provision({ attemptId })

const settings = await bota.provisioning.readConnectionSettings()
await bota.provisioning.writeConnectionSettings({
  ...settings,
  enabledConnections: { ...settings.enabledConnections, wifi: true },
})

const networks = await bota.wifi.scanNetworks()
await bota.wifi.configure(
  { ssid: selectedNetwork.ssid, password: enteredPassword },
  wifiGrant,
)
const wifiStatus = await bota.wifi.readStatus()
const wifiSubscription = await bota.wifi.subscribeToStatus(renderWiFiStatus)

await bota.controls.startRecording({ authorityId: recordingAuthorityId })
await bota.controls.stopRecording({ authorityId: recordingAuthorityId })

await wifiSubscription.remove()
```

Provisioning closes the prepare/physical-result/confirm-or-abort loop. A
successful backend prepare is not a completed bind. Remove-only deprovisioning
uses `bota.provisioning.deprovision({ grant })`; it is non-destructive and must
not be described as factory reset. WiFi credentials and control grants are
volatile and are scrubbed on terminal paths where JavaScript permits.

## Firmware update and recovery

Check the independently reported browser capability before starting:

```ts
const capabilities = bota.devices.getCapabilities()
if (!capabilities.firmwareUpdate) {
  throw new Error('Firmware update is unavailable in this browser')
}

await bota.ota.updateFirmware(firmwareImage, {
  operationId: firmwareOperationId,
  onProgress: ({ phase, completedBytes, totalBytes }) => {
    renderFirmwareProgress(phase, completedBytes, totalBytes)
  },
})
```

The SDK streams the response to OPFS and verifies exact length, SHA-256, and
CRC32 before the first OTA GATT mutation. Reboot recovery uses only the exact
previously verified browser device ID and never opens the picker. Continue a
durable operation with `resumeFirmwareUpdate(operationId)` and stop it with
`cancelFirmwareUpdate(operationId)`. Reload validates journal, checkpoint, and
blob compatibility before GATT. A terminal `cleanup_only` journal performs
only idempotent local cleanup and does not call the provider or device.

## Device logs

```ts
const logSubscription = await bota.logs.subscribe(({ message, isBacklog }) => {
  renderDeviceLog({ message, isBacklog })
})

await logSubscription.remove()
```

Only one device-log owner is allowed. Rust emits complete sanitized lines; raw
packets and decoder details do not reach the callback. Explicit removal,
listener failure, disconnect, and `destroy()` cancel the exact workflow and
remove its characteristic subscription before ownership is released.

## Logout or tenant change

```ts
await bota.destroy()
await bota.clearPersistedData()
```

Use that order. `destroy()` is terminal and idempotent: it rejects new work,
joins picker/reconnect startup, cancels active owners, removes passive
subscriptions, and performs one final disconnect. `clearPersistedData()` is
local-only, BLE-free, and repeatable after destruction; it clears only the
client's tenant namespace. Do not share a namespace between organizations,
projects, or users.

Manager names exported from the package root are TypeScript instance types.
Obtain managers from the client; direct manager construction is not public API.

## Capability matrix

| Capability | Candidate support |
|---|---|
| Explicit picker connect, disconnect, exact-identity snapshot | Supported in the foreground |
| Saved exact-device reconnect | Supported when authorized-device enumeration is available |
| Recording list, legacy sync, cancellation, recovery | Supported with durable storage and `recordingUpload` |
| Encrypted Upload v2 | Supported only when freshly advertised and exactly host-authorized |
| Provisioning and remove-only deprovision | Supported with `provisioning` |
| Connection settings | Supported |
| WiFi scan/configure/disconnect/status/subscription | Supported in the foreground |
| Recording start/stop | Supported with `recordingControl` |
| OTA download/transfer/reboot/reconnect/reload recovery | Supported with durable storage and `firmwareDownload` |
| Device logs | Supported as one foreground subscription |
| Background scan, service-worker Bluetooth, closed-tab work | Unavailable |
| Live recording streaming | Unavailable |
| Authenticated destructive factory reset | Unavailable |
| Safari/iOS fallback or Bluetooth polyfill | Unavailable |
| Flutter Web and Windows | Unavailable |
| Built-in Bota API authentication/client | Unavailable; application-owned by design |

Browser capabilities are reported independently by
`bota.devices.getCapabilities()`. An unavailable optional capability fails
before device mutation with a stable SDK error. Web Bluetooth permission alone
is never treated as device identity or backend authorization.

## Physical acceptance

Automated Chromium uses deterministic fake Bluetooth and storage boundaries;
it is not physical-device evidence. Run the supervised matrix
in [`docs/testing/web-physical-device.md`](../../docs/testing/web-physical-device.md)
with one exact device and record the result in the matching release evidence.
