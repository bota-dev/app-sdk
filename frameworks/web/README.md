# Bota SDK for Web

Published `2.0.0-beta.17` retains Web's Rust/Wasm implementation and the existing
public package identity. Exact public npm bytes match the approved main-CI
inventory. React Native's generated-JS route uses its original `/runtime` entry.
All five package/public-consumer gates pass; app/device acceptance remains
separate. See the [publication review](../../release/evidence/2.0.0-beta.17-publication.md).

`@bota.dev/web-app-sdk` is the foreground browser distribution of the Bota App
SDK. It combines Web Bluetooth and tenant-scoped browser storage with the shared
Rust core compiled to WebAssembly. Rust owns protocol sequencing, integrity,
checkpoints, and stable workflow errors; the application owns authentication,
backend calls, user consent, and presentation.

Historical `@bota.dev/web-sdk@1.2.0-beta.7` is public. The renamed
`2.0.0-beta.0` distribution is also public; physical-device acceptance remains
open. Remove the old
dependency before adding its replacement. Storage namespaces do not change.

## Install

Install the verified public beta.17 version explicitly; npm `latest` remains
beta.0:

```bash
npm install --save-exact @bota.dev/web-app-sdk@2.0.0-beta.17
```

Use a secure context in a desktop Chromium browser with Web Bluetooth. The
initial `connect()` call must run directly from a user gesture because it opens
the browser picker. A previously authorized exact device may be reconnected
without a picker only when `navigator.bluetooth.getDevices()` is available.

The beta.2 candidate fixes short UUID lookup and the browser's blocked standard
serial read. It requires firmware exposing read-only Bota Identity service
`B07A0008-0000-1000-8000-00805F9B34FB`, serial characteristic
`B07A0008-0001-1000-8000-00805F9B34FB`. This returns the same serial as `0x2A25`,
which Chrome blocks. Exact serial verification is unchanged; firmware without
this endpoint cannot connect through Web and fails closed. Native SDKs keep
their standard serial read. These source fixes require matching firmware and
Web package releases before installed consumers get them. After upgrading,
select the device in the picker again to grant access to the new service.

## Local client metadata (source preview)

`client.clientPresence.nextReport(device.id)` returns a local diagnostic report
for the currently verified SDK device handle, or `null` when disconnected. It
does not read Bluetooth, call a backend, or start a timer. The report contains
`schema_version`, random per-connection `session_id`, increasing `sequence`,
`platform`, and release-generated `sdk_package` / `sdk_version`. Reconnect
rotates the session; disconnect and destroy invalidate it. A stale disconnect
callback cannot clear a newer connection's report.

```ts
const device = await client.devices.connect({ expectedSerialNumber })
const context = await client.clientPresence.nextReport(device.id)
// Local-only by default. No HTTP is performed by this getter.
```

An integrating host may attach this report to its existing authenticated
heartbeat relay after obtaining fresh device readings and verifying the same
device/project/binding still owns the connection. The host adds the captured
binding generation and, optionally, a developer-supplied app identifier. Reuse
the same report for an immediate retry; never queue/replay stale observations.
Stop reporting on hidden pages, logout, disconnect, or scope change. App
identifier, SDK version and serial matching are not attestation or permission
to deliver commands. Do not include phone names, persistent installation IDs,
URLs, full user agents, location, or credentials. Metadata is self-reported
operational information, not proof of continuous physical connectivity.

Published beta.17 includes `clientPresence.nextReport`; historical beta.1 lacks
this additive API. Backend integration and fresh presence observations remain
host-owned.

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

// Host calls bind with credential_delivery: hpke_v1 and relays only the envelope.
// credentialEnvelopeBase64 is the host adapter encoding of credential_envelope.data.
const provisioning: ProvisioningProvider = {
  async prepare(context) {
    const response = await postHost<{
      materialId: string
      apiEndpointBase64: string
      credentialEnvelopeBase64: string
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
      deviceToken: new Uint8Array(),
      credentialEnvelope: decodeBytes(response.credentialEnvelopeBase64),
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

// Each attempt reads a fresh 16-byte device nonce before invoking prepare.
// The host forwards it as nonce_d to its authorized recording-grant endpoint.
// Missing/malformed nonce fails closed. Do not retain callback bytes or grants.
const recordingControl: RecordingControlProvider = {
  async prepare(context) {
    const response = await postHost<{ grantBase64: string }>(
      '/sdk/recording-control/prepare',
      {
        operationId: context.operationId,
        serialNumber: context.serialNumber,
        action: context.action,
        authorityId: context.authorityId,
        nonceHex: Array.from(context.nonce, byte => byte.toString(16).padStart(2, '0')).join(''),
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
  async prepareUploadContext(context) {
    const response = await postHost<{ contextId: string; challengeBase64: string }>(
      '/sdk/recordings/v2/context', { serialNumber: context.serialNumber, nonceBase64: encodeBytes(context.nonce) }, context.signal)
    return {
      challenge: decodeBytes(response.challengeBase64),
      async exchangeProof(proof, signal) {
        const result = await postHost<{ resultBase64: string }>(
          '/sdk/recordings/v2/context/proof', { contextId: response.contextId, proofBase64: encodeBytes(proof) }, signal)
        return decodeBytes(result.resultBase64)
      },
    }
  },
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
      nonceBase64: encodeBytes(context.nonce),
      previousSession: context.previousSession,
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

The source context callback relays the existing capability-bit-8 upload-only
exchange before listing/authorization and before receipt delivery. Rust owns
its codecs; the host returns opaque signed challenge/result bytes, not trusted
time or key claims. Both recording control and v2 preparation receive a fresh
16-byte device nonce. Treat these buffers as temporary and propagate cancellation.

On resume, `previousSession` carries the persisted recording/session/owner even
before a byte checkpoint exists. An explicitly recovered expired or nonce-changed session may
return `replacesSessionId`; the default storage atomically replaces identity and
resets offsets before transfer. Custom storage must implement
`replaceEncryptedUploadV2Operation` to support this path. Fresh backend status
may set `stagingAccepted`/`manifestAccepted` to avoid re-uploading accepted
artifacts, but publication and exact receipt/device acknowledgement are still
required. Never infer these flags from local HTTP PUT success.

Replacement validates the signed document's structural owner, recording,
ciphertext, policy and replacement flag through the shared Rust decoder before
changing the journal or truncating retained bytes. This is not cryptographic
verification; the device remains the signature authority. One exclusive owner
covers fresh nonce/context reads, provider preparation and an atomic handoff to
the transfer workflow. Disconnect aborts that preparation; a late provider cannot
write on a new connection, even for the same serial.

Hosts must reconcile lost session-creation responses through their authenticated
backend contract and return the latest matching owner. Portal has adopted its
scoped reconciliation and nonce-change recovery extension. Published-package
and physical-device gates remain separate. Historical P10 relay must fail closed in a host that
does not implement its dedicated relay endpoint; never send it to plaintext S3.

Create one client for the signed-in tenant and keep it for the page lifetime:

```ts
const bota = await createExampleClient({ organizationId, projectId, userId })
```

## Picker connection, reconnect, and snapshot

For an existing device, the expected serial must come from the authenticated
application device record. An advertised Bluetooth name is display/filter
metadata only.

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
identity, status, and capability values. Capability decoding recognizes firmware
upload-context and expired-session-recovery bits (`0x37f` for the current batch
profile); this is not evidence that every advertised workflow has passed Web
hardware acceptance. Unknown capability bits still fail closed.

### Discover identity before registration

`connectSelected()` requires `2.0.0-beta.3` or later; it is not included in
`2.0.0-beta.1`. It opens the browser picker and returns the selected device only
after the shared Rust workflow reads and validates its physical serial number.
Call it directly from a user gesture, with the client initialized beforehand:

```ts
addDeviceButton.addEventListener('click', async () => {
  const device = await bota.devices.connectSelected()
  // Use device.serialNumber in your authenticated registration/binding flow.
  // Registration and binding do not happen automatically in the SDK.
})
```

No manual SN entry, backend record, storage, or provider is needed to discover
the serial. Browser permission and a serial read are not proof of ownership.
Provisioning still requires the application provider and tenant-scoped storage;
show pairing success only after physical provisioning and backend confirmation.
Use exact `connect` or `reconnect` for a known device, not discovery as a fallback
after an identity mismatch. A null, missing, or non-string expected serial is
invalid input, never an implicit request for discovery.

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

## Optional speech sessions (unreleased source preview)

The separate `@bota.dev/web-app-sdk/speech` entry accepts host-authorized session
configuration and short-lived media grants. It does not use the Bluetooth
connection, upload journal, or Bota project API keys. It runs the shared Rust
speech policy through WASM. No published package or live RTC qualification is
implied by this source preview.

The host backend owns session admission, subscription updates and grant renewal.
Map its responses to `SpeechConfiguration`, `SpeechSubscription` and
`SpeechGrant`; do not infer those permissions in the browser. The synthetic
[protocol fixture](../../protocol/speech-session/client-v1.json) documents the
candidate shape without real credentials.

```ts
import { Room, createLocalAudioTrack, setLogLevel, LogLevel } from 'livekit-client'
import { createWebSpeechSession } from '@bota.dev/web-app-sdk/speech'
import { createLiveKitWebMedia } from '@bota.dev/web-app-sdk/speech/livekit'

const speech = await createWebSpeechSession({
  configuration, // Authorized host snapshot, including this listener's subscription.
  grant,         // Short-lived member grant from the host backend.
  host: {
    changeSubscription: (selection, signal) => host.changeSpeechSubscription(selection, signal),
    renewGrant: signal => host.renewSpeechGrant(signal),
    readCaptions: (request, signal) => host.readSpeechCaptions(request, signal),
  },
  mediaFactory: callbacks => createLiveKitWebMedia(callbacks, {
    roomFactory: options => new Room(options),
    createMicrophone: options => createLocalAudioTrack(options),
    silenceVendorLogs: () => setLogLevel(LogLevel.silent),
  }),
  onEvent: event => showSpeechEvent(event),
  onCaption: caption => upsertCaption(caption.key, caption),
  onError: error => showSpeechStatus(error.code),
})
await speech.ready
await speech.setMicrophone(true)
await speech.setListening(true)
// Invoke resumeAudio directly from the user's gesture when autoplay is blocked.
await speech.resumeAudio()
// A language change keeps capture active and fences old playback.
await speech.changeSubscription({ targetLanguage: 'ja', mode: 'translated', sourceParticipantIds })
// On leave, logout, or tenant change, await terminal cleanup.
await speech.close()
```

The candidate adapter is exercised against LiveKit client `2.23.0`. Supply its
public factories from the host's installed runtime; supplier declaration files
are not part of the Bota public type surface. LiveKit's current declarations
have strict exact-optional incompatibilities, so the host must separately qualify
its vendor import/build configuration. The example disables vendor logs in the
shared JavaScript realm; integrate that with the host's logging policy.

The adapter captures the microphone by default, or accepts one authorized
external participant track through `externalInput`. The customer backend must
first admit that participant with `source_kind: 'host_external'`. The adapter
checks the supplied participant/member generation against the grant and derives
an independent track from the original's rendered audio using its own Web Audio
context. Host mute remains authoritative; a direct track clone would bypass
later changes to the original's `enabled` state. It never mutes or stops the host
original. Supply the vendor's public wrapper for that exact owned branch:

```ts
externalInput: {
  participantId: grant.participant_id,
  memberGeneration: grant.member_generation,
  track: authorizedOriginalAudioTrack,
  wrapTrack: ownedBranch => new LocalAudioTrack(ownedBranch, undefined, true),
}
```

Import `LocalAudioTrack` from the host's `livekit-client`. The input must be a live
audio track for that one speaker; a mixed conference track cannot establish
per-person identity. No `createMicrophone` factory is needed for external input.
Start input from a user gesture where browser audio activation requires it.
If the owned audio context cannot run, input fails without a microphone fallback.
Optional browser factories must return a fresh context owned solely by Bota;
input retirement closes that context and stops its destination track.
Use `setInput(true)` and `finishInput()` for either source kind; these are aliases
of the existing shared-policy microphone controls, not separate state machines.
The existing `microphoneEnabled` state field and media-port names are unchanged.
Closing joins late acquisition, publication and connection work before resolving.
Host-specific capture clocks, original archive correlation and real RTC remain
qualification work.
Microphone capture starts only on an explicit call; listening, microphone mute
and subscription changes are independent. A successful subscription callback
acknowledges desired state, not audible playback: the worker-applied revision and
actual old-buffer clearing must also complete. Sender completion does not cut off
the listener's trailing audio. `close()` is terminal; reconnect requires a new
authorized session owner. Errors expose fixed codes, not vendor responses or
credentials. The SDK retains no transcript history.

For normal source completion, call `await speech.finishMicrophone()`. It silences
new microphone input immediately, keeps the exact publication while the server
processes its accepted tail, and leaves listening connected. After a terminal
result it unpublishes that input; await this method before enabling a new
microphone publication. Ordinary mute/unpublish and `close()` remain interruption
paths. The optional LiveKit adapter implements the required `holdMicrophone` and
`microphonePublication` port capabilities, including late acquisition/publication.

Supply optional `host.finishSource(request, signal)` through an authenticated
customer proxy. On the first request, `sourceId` and `sourceEpoch` are null: resolve
exactly one registered source from the session's `sources`, matching the actual
signed-in publisher, member generation, current worker generation and local
`trackSid`. A source not registered yet is temporarily unavailable. Never select
the latest or another speaker's source. POST its exact identity to
`/v1/speech-sessions/:id/participants/:participantId/sources/:sourceId/finish` with
`member_generation`, `worker_generation`, `source_epoch` and `track_sid`, and return
the response JSON unchanged. Later requests carry the pinned source ID/epoch and
must reuse them. Client-provided IDs are not authorization; project keys stay in
the proxy. Map denied, stale and temporary outcomes to `SpeechSourceFinishError`
codes `unauthorized`, `stale_source` and `unavailable`, and honor cancellation.

`state.sourceFinish` reports preparation, requested/draining and terminal states.
`no_source` means no local publication existed, not completed ASR. Shared Rust
checks returned ownership, worker/source identity, transitions and immutable
boundary counters. It polls at one-second intervals with a 90-second processing
deadline; each host request has a five-second timeout. Concurrent calls share one
operation. An unavailable outcome preserves the muted publication and pinned
identity for explicit `finishMicrophone()` reconciliation or terminal `close()`;
it cannot resume capture or silently choose a new source. Authorization loss
closes the owner. `completed` covers server processing, not successful translation
for every listener, actual hearing or original-archive completeness. The helper
rejects unsupported ports/proxies before changing capture.

`readCaptions` is optional and calls the customer's authenticated backend proxy,
which forwards the current session/member/subscription and opaque cursor to the
caption endpoint. Return its JSON body unchanged; map denied authorization to
`SpeechCaptionReadError('unauthorized')`, an obsolete subscription/cursor to
`SpeechCaptionReadError('stale_subscription')`, and temporary failures to
`SpeechCaptionReadError('unavailable')`. Keep project keys on that backend.
The proxy must also authorize the actual signed-in listener; client-supplied IDs
are not authorization. Abort the request when its signal is cancelled.

Shared Rust validates each entire page before emitting `onCaption` updates. It
requests eight records at a time, waits 250 ms between backfill pages, polls an
exhausted cursor every two seconds, and backs off five seconds after temporary
failure. `recoverCaptions()` joins the current page or requests an immediate retry;
it does not wait for the entire meeting history. Polling and caption recovery do
not synthesize or play audio. Temporary read failures leave capture running;
explicit authorization denial closes the owner. A stale subscription stops old
playback until the host supplies a newly authorized selection.

Use `onCaption` for both live and recovered text and upsert by its stable `key`,
keeping confirmed text final. The SDK retains only 1,024 recent identity hashes,
not complete text history; apps must keep their own idempotent view and never
replace a final record with an interim one after eviction or reconnect. Do not
append the same caption again from `onEvent`. State snapshots exclude content.
Language changes cancel the old read and discard its cursor; late responses are
ignored. A fresh authorized owner starts recovery from the beginning, and the
stable keys allow the app to merge that history. Live-only sessions report
`unavailable` without invoking the recovery callback; keep their UI text volatile.

Web media still follows LiveKit Cloud's region routing; the public JS client has
no adapter-level switch to disable initial regional fallback. Qualify the Cloud
project's permitted regions before enabling a cohort. Browser autoplay, AEC,
device changes, network loss, TURN, archive correlation and real-provider latency
need separate runtime qualification. This module does not establish original
audio archival or device-speaker support.

### Two-speaker browser companion

The source-only [conversation page](../../tests/consumers/web-vite/speech.html)
uses the packed Web SDK, its actual Rust/Wasm policy and the public LiveKit
`2.23.0` factories. It provides A/B roles, paired original/translated captions,
independent microphone and listening controls, receiving-language/mode changes,
autoplay recovery, normal source finish and joined terminal cleanup. It starts
with both capture and listening off. Changing roles requires leaving first;
another tab's receiving preference remains independent.

The [loopback host](../../tools/web/serve-speech.mjs) is an operator lab example,
not a deployed authentication service. It serves the built page only on
`127.0.0.1` and proxies the existing speech control API. Each independent access
code maps to one pre-admitted participant UUID and fixed member generation.
The browser cannot choose another participant, project, source set or API origin.
Project credentials stay in the Node process; only that role's short-lived grant
reaches the SDK. Requests are bounded, cancellable, no-store and not retried
after an uncertain mutation. Production hosts must replace the lab codes with
their signed-in principal and fresh membership authorization.

Before running the lab, the authorized host must create an active, media-ready
session with two current `host_microphone` participants and initial subscriptions
that each select only the other participant. Both must have publish/subscribe
permission. Receiving languages must be included in the session's allowed set.
This example accepts only explicitly selected `text_only` or `live_only` sessions.
It rejects `original_audio_and_text`, external sources and replaced members before
requesting a grant; it has no phone/browser encrypted original-capture profile
and never silently changes retention.

From the repository root, build and verify the packed consumer with the pinned
Node/Rust/Web toolchain, then load the operator configuration from a private,
untracked environment file:

```sh
npm run web:verify
node --env-file=/absolute/path/to/private-speech-lab.env tools/web/serve-speech.mjs
```

| Environment variable | Required value |
| --- | --- |
| `BOTA_SPEECH_API_ORIGIN` | The explicitly selected Bota API origin; HTTPS, or HTTP on `127.0.0.1` for a disposable local backend. |
| `BOTA_SPEECH_API_KEY` | A server-side credential with `speech_sessions:read` and `speech_sessions:write`. Never use a `VITE_` variable for this value. |
| `BOTA_SPEECH_PROJECT_ID`, `BOTA_SPEECH_SESSION_ID` | The same authorized project and already-created session. |
| `BOTA_SPEECH_A_PARTICIPANT_ID`, `BOTA_SPEECH_B_PARTICIPANT_ID` | Two distinct admitted participant UUIDs. |
| `BOTA_SPEECH_A_MEMBER_GENERATION`, `BOTA_SPEECH_B_MEMBER_GENERATION` | Their exact current positive member generations. |
| `BOTA_SPEECH_A_CODE`, `BOTA_SPEECH_B_CODE` | Independent random access codes, each 32–128 characters, shared only with the intended lab operator. |
| `BOTA_SPEECH_PORT` | Optional loopback port; defaults to `4173`. |

Open the printed loopback URL, choose the assigned role and enter its access code.
Join does not start the microphone. Use **Start microphone** and **Start listening**
independently; **Finish speaking** holds the exact publication until the SDK
reports processing completion or an explicit unavailable/interrupted outcome.
Listening remains connected. **Leave** interrupts remaining work, clears the
volatile caption view and joins cleanup. An uncertain cleanup disables a new
owner until the tab is closed. A revision conflict requires leaving and reading a
fresh authorized snapshot, rather than overwriting another preference.
Explicit authorization denial during a preference update immediately retires
the owner and clears the view; temporary preference failures retain independent
capture and require reconciliation before another change.

The view keeps at most 100 paired passages in memory, renders text as text, and
does not persist captions, grants, cursors or access codes in browser storage.
Text retention remains a backend session policy; input processing completion does
not mean translated audio was heard or an original archive was verified.
Separate browser tabs do not separate physical speakers: use qualified independent
inputs/devices, or explicitly change role between turns on a shared microphone.
Headset, AEC, overlapping speech and real cloud behavior remain qualification work.

The existing packed-consumer browser gate exercises this same view and real
Rust/Wasm policy through synthetic HTTP/media boundaries. Its separate
`speech-check.html` harness is not served by the operator host. A normal-entry
check loads the actual vendor bundle without opening media or contacting a host.
Host regressions also cover real loopback HTTP, role/origin isolation, immutable
member binding, exact source finish, cancellation and bounded admission.
These checks do not establish encoded RTC delivery, ASR/MT/TTS quality, measured
latency, production login, device acceptance or any other SDK family's App adoption.

## Physical acceptance

Automated Chromium uses deterministic fake Bluetooth and storage boundaries;
it is not physical-device evidence. Run the supervised matrix
in [`docs/testing/web-physical-device.md`](../../docs/testing/web-physical-device.md)
with one exact device and record the result in the matching release evidence.
