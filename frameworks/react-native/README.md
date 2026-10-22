# Bota SDK for React Native

Source candidate `2.0.0-beta.20` includes the scoped encrypted-v2 completion,
Find revision-2 authorization and BLE naming/model corrections. It retains
`@bota.dev/react-native-app-sdk/runtime` and version 1 installed OS ports.
Published beta.19 remains the installation baseline until protected publication
and public-consumer checks pass. Earlier qualification notes below are dated
snapshots; see the [current preflight](../../release/evidence/2.0.0-beta.20-preflight.md).
Find requires qualified device firmware. Native-only Find adapters are not
available, and physical Find remains unverified. App delivery and OTA remain
separate gates.

## Generated JavaScript runtime and app OTA updates

The unpublished [system-connection discovery correction](../../docs/parity/apple-connection-ownership.md#react-native-generated-runtime-system-retrieval)
lets `createBlePlxPort` query an installed manager's optional `connectedDevices`
API during scanning. Retrieved candidates still require a normal local connect
and full serial verification. This source change is not in public beta.20;
publication and physical iPhone recovery remain separate.

The unpublished [managed completion handoff](../../docs/parity/managed-completion-retirement.md)
retains confirmed journal completion across normal transport retirement, while
preserving explicit cancellation and scoped durable cleanup checks.

The unpublished [diagnostic cleanup correction](../../docs/parity/retired-log-cleanup.md)
skips unsubmitted log STOP after retirement, joins submitted writes and captured
monitors, and observes void log-removal rejections. Genuine cleanup failures
remain visible; fresh qualification and phone teardown remain separate.

The unpublished configure-retirement follow-up logs debug only when exact
cancelled initialization belongs to an admitted destroy and cleanup succeeds.
Rejection/error events and genuine failures remain unchanged. See the
[current qualification boundary](../../docs/parity/configure-retirement.md).

The unpublished Rust connection follow-up retires exact late attempt results
while joining Disconnect after a deadline. See the [candidate boundary](../../docs/parity/connection-attempt-retirement.md);
canonical adoption and 504 local RN tests pass; fresh main and normal reconnect
acceptance remain pending.

The unpublished ordinary-control correction orders simultaneous status,
subscription and settings calls before their executor leases. It accepts one
active and up to 32 pending calls, retains exact scope/connection identity and
rejects queued work on teardown. Workflow and BYO ownership remain exclusive.
See [source qualification](../../docs/parity/ordinary-control-admission.md).

The unpublished bound-model correction adds optional `resolveBoundDeviceModel`
to `createBotaReactNativeJsRuntime`. Supply only an authenticated exact current
binding record `{serialNumber, model, bindingGeneration}`; return `null` when
unavailable and invalidate the runtime on account/project/binding/model changes.
Rust permits this fallback only for legacy GATT model `BOTA_DEV`, rejects
conflicts and preserves Note cellular normalization. See the
[qualification boundary](../../docs/parity/bound-device-model.md).

Published beta.18 corrects Android MTU observation in the BLE PLX OS port using
BLE PLX 3.5.1's existing installed API. Its accepted main qualification,
protected publication and public consumer checks pass; see the
[publication evidence](../../release/evidence/2.0.0-beta.18-publication.md)
and dated [preflight](../../release/evidence/2.0.0-beta.18-preflight.md).

Published beta.17 adds `deriveSyncStatus`, `UPLOAD_RECOVERY_VERSION` and
`readClientPresenceObservation` to `/runtime`. Use the generated runtime's
`createUploadRecoveryProvider` method to retain shared Rust recovery policy.
The pure `isEmptyLegacyAndroidV2CheckpointCatalog(bytes)` helper uses generated
Rust to recognize the exact empty catalog left by successful native Android
cleanup. An OS inventory may supply its complete file or a 13-byte prefix for
longer files. Unknown, truncated, trailing or pending evidence remains blocked;
this helper does not import legacy queues/files or authorize their removal.
Use each generated runtime for one configured lifetime. Make repeated app-level
configuration idempotent, and create a fresh runtime after destruction or a
scope change. Reconfiguring the same `runtime.client` currently destroys its
generated core and rejects with `runtime_destroyed`; the native compatibility
client's reusable-instance behavior is not established for this factory.
Managed encrypted-v2 `baseUrl` accepts HTTPS origin-root routes (for example
`https://your-backend.example/`) and existing path prefixes. Root normalizes to
an explicit empty API prefix; an omitted low-level prefix still defaults to
`/v1`. All beta.17 public package/consumer gates pass; installed-app and physical
qualification remain separate.

Published beta.17 includes `createBotaReactNativeJsRuntime` in the
`@bota.dev/react-native-app-sdk/runtime` entry. Rust supplies the executable JS
protocol/workflow implementation; no WebAssembly or native Rust engine runs in
the application. Its exact public npm archive matches the approved main-CI
inventory. A fresh public install configures and destroys the generated client
with native imports, registry access and WebAssembly rejected; strict declarations
also compile. All five package/public-consumer gates pass; separate app/device
acceptance is tracked in the
[publication review](../../release/evidence/2.0.0-beta.17-publication.md).
The ordinary package retains native adapters, Codegen, autolinking and its
compatibility API. Importing `/runtime` evaluates without native module imports
or registry access; selecting it does not disable package autolinking. The
companion directory is a private verification fixture with no npm publication.

### Optional native autolinking exclusion

An app using the generated factory and installed generic OS ports can exclude
the bundled Bota native adapters in its app-side `react-native.config.js` before
building:

```js
module.exports = {
  dependencies: {
    '@bota.dev/react-native-app-sdk': {
      platforms: { ios: null, android: null },
    },
  },
};
```

Generic BLE, files and other host libraries must still be installed. The native
compatibility factory requires its adapters to remain linked. Importing `/runtime`
alone does not change linking. This follows the
[React Native CLI configuration](https://github.com/react-native-community/cli/blob/main/docs/autolinking.md#how-can-i-disable-autolinking-for-unsupported-library);
installed-app and physical qualification remain pending.

```ts
import { createBlePlxPort, createBotaReactNativeJsRuntime,
  type BotaJsHostPorts } from '@bota.dev/react-native-app-sdk/runtime';

const lifetime = new AbortController();
const ports: BotaJsHostPorts = {
  apiVersion: 1,
  platform: 'ios',
  signal: lifetime.signal,
  checkScope: assertCapturedAccountProjectAndBinding,
  ble: createBlePlxPort(installedBleManager),
  persistence: privateScopedPersistence,
  files: reopenableScopedFiles,
  randomBytes: secureRandomBytes,
  network: registeredNetworkTransfers,
};
const runtime = createBotaReactNativeJsRuntime(ports, {
  backend: { fetch: redirectRefusingHttps },
  uploadFile: uploadOpaqueFile,
  openSocket: openAuthenticatedSocket,
});
await runtime.client.configure({ environment: 'production' });
lifetime.abort(); // logout, reassignment or teardown
await runtime.client.destroy();
```

The generic BLE port reports actual radio and permission state through optional
`readBluetoothState`/`observeBluetoothState` ports, normalized by generated Rust.
Without those observations the generated client remains `unknown`, and
`waitForBluetooth` cannot report readiness. Teardown joins state observations.
BLE PLX MTU observations use its connected `requestMTUForDevice` result; Android
scan-cache `devices()` entries can omit the negotiated capacity. Cancellation
joins the submitted transaction before releasing the captured connection.

The named host values implement exported primitive interfaces. Hosts obtain
Bluetooth permissions and own installed libraries. Files support scoped reopen,
bounded reads and durable flush/readback. Journals retain one captured private
namespace. HTTP/file upload refuses redirects before credentials/data are sent
and joins cancellation; RN's default XHR-backed fetch cannot provide that fence.
Optional WSS preserves the qualified BYO subprotocol and joins pending I/O on
close. Shape preflight checks API version 1 before any OS effect.

Generated Rust chooses framing, transfer windows, retries, backend recovery and
receipt-gated cleanup; JS executes OS I/O. Ciphertext and signed documents are
bounded internal SDK transport values, while public APIs return metadata and
progress/results. V2/BYO keys remain on the device or behind installed secure
handles; JS gains no signing/decryption authority. The historical private-PEM
import remains a compatibility gap outside the modern key target.

Generated firmware update uses the canonical Rust OTA/reboot recovery loop.
`firmwareRecovery.timeoutMs` can narrow its budget; `delayMs` is legacy-adapter
behavior only. Fresh serial/version readback proves installation; an ACK cannot.
Custom v2 providers use `readEncryptedUploadV2AuthNonce(operationId)` and the
operation-scoped `registerEncryptedUploadV2Material`/`releaseEncryptedUploadV2Material`
registry. Managed v2/BYO/status factories use supplied scoped HTTP effects.
See the [complete port/material contract and review](../../docs/parity/react-native-runtime.md).

Beta.16 retains beta.15's native compatibility corrections: Apple single-ATT
transfer bounds and local connection ownership,
awaitable React Native reconnect pause, and the reviewed main OTA, recording
marker, protected-status and BYO storage changes. Generated-JS npm publication,
consuming-app OTA and physical acceptance remain separate gates. Generic
OS ports must be installed in an initial app binary; compatible generated logic
can subsequently update through the app's OTA mechanism. New OS capabilities or
transport fixes still require an app build.
The managed Apple backend also matches the strict session-create request without
an EndUser override; recording creation and native scope fences retain EndUser.
See [request correction](../../docs/parity/v2-managed-backend.md#october-12-apple-session-request-correction).

Bluetooth device SDK for Bota Pin and Bota Note applications. The 2.x distribution
preserves the public TypeScript API of `@bota.dev/react-native-sdk@0.0.65`
through its existing native adapters. The generated factory is a separate execution
path over primitive OS ports; it does not call those full Bota native workflows.

The setup and native-material examples below describe the bundled root entry.
Generated-mode consumers use the version-1 generic ports above.

## Requirements

App SDK beta.6 and later expose `BotaDeviceSDK.clientPresence.nextReport(deviceId)`.
It returns `BotaClientPresenceContext | null` from the native verified connection,
preserving native session/sequence while identifying this React Native package
and its generated version. It makes no HTTP call or device command. Destroy
discards late metadata results. The host explicitly relays a report alongside
fresh status; see the root README. The frozen compatibility `BotaClient` and
compatibility `DeviceManager` APIs are unchanged. Rebuild native binaries when
adopting changes to that native API.

- React Native `0.86.3` or newer with the New Architecture enabled
- iOS `15.1` or newer
- Android API `26` or newer
- Node.js `22` or newer for installation and application builds

## Install

Published beta.17 includes the generated-JS factory through `/runtime` and retains
the native-adapter path. See the
[publication review](../../release/evidence/2.0.0-beta.17-publication.md).
Rebuild native applications and reconnect explicitly after connection loss.
Physical completed-resume acceptance and wider GATT recovery remain separate.
Remove `@bota.dev/react-native-sdk` before adding the replacement; do not
co-install both. Standalone maintenance ended September 29, 2026; follow the
[retirement and migration notice](../../docs/migrations/react-native-sdk-sunset.md).

```bash
npm install --save-exact @bota.dev/react-native-app-sdk@2.0.0-beta.17
npx pod-install
```

Rebuild the native iOS and Android applications after installation. An Expo Go
runtime cannot load this native module; use a development or production build.

An application-native upload pod may depend on `BotaDeviceSDK`. With static
SwiftPM linkage, the SDK's CocoaPods workaround normalizes the module-map path
in both aggregate and dependent-pod cached build settings. This preserves the
path when Expo later writes macro flags. Do not work around missing module maps
by adding another copy of the Apple SDK.

Expo prebuild and EAS projects must set the Android minimum SDK explicitly. Add
the Expo-compatible `expo-build-properties` package and configure it in the app
config:

```ts
plugins: [
  [
    'expo-build-properties',
    {
      android: {
        minSdkVersion: 26,
      },
    },
  ],
],
```

## Configure

```ts
import { BotaClient } from '@bota.dev/react-native-app-sdk';

await BotaClient.configure({
  environment: 'production',
});

await BotaClient.waitForBluetooth();
```

The `BotaClient.devices`, `BotaClient.recordings`, and `BotaClient.ota`
managers become available after configuration completes.

Published beta.15 workspace coordination adds
`await BotaClient.devices.pauseAutoReconnect()`. Fence new reconnect work and
retry rearming first, then inspect fresh device activity and disconnect idle
connections before changing scope. This method waits for submitted reconnects;
it does not itself disconnect. Existing `disableAutoReconnect(): void` remains
unchanged. Earlier beta.14 does not include the addition; see
[verification and delivery limits](../../docs/parity/workspace-reconnect-quiescence.md).

Discovery exposes the manufacturer-advertised `macAddress` as uppercase,
colon-separated bytes (`AA:BB:CC:DD:EE:FF`), preserving the legacy React Native
registration contract. Compact native addresses are formatted at the RN
boundary; missing or malformed advertised values become `null`. The peripheral
`id` is unchanged and is never substituted for an absent advertised MAC.

## Encrypted upload v2

Current source includes `createEncryptedUploadV2Backend` for iOS/Android. Supply
your authenticated backend URL, fresh-token callback and scoped identity; the
SDK owns native session journaling, manifest replay, verification polling and
signed-receipt delivery. See the [managed integration](../../docs/parity/v2-managed-backend.md)
for the example, backend routes, restart trigger and release limits. Beta.10
does not contain this helper. The low-level provider below remains supported.

The target encrypted-upload-v2 runtime is an additive `BotaDeviceSDK` API; it
does not change the legacy `BotaClient` recording providers or events:

```ts
import { BotaDeviceSDK } from '@bota.dev/react-native-app-sdk';

await BotaDeviceSDK.recordings.syncEncryptedRecordingV2(
  device,
  recording,
  async (request) => selectNativeEncryptedUploadV2(request),
  (progress) => updateUploadProgress(progress),
);
```

For the installed native-adapter path, the provider receives a fresh native capability snapshot, immutable recording
identity, and optional versioned checkpoint. It returns only the upload
session, owner revision, security policy, and an opaque native material
registration ID. Before returning that ID, application-native Swift or Kotlin
code must register the complete material once with
`BotaDeviceSDKEncryptedUploadV2Materials.register(...)`. Authorization,
manifest, receipt, staging URL/header/credentials, native file bytes/paths,
keys, nonces, tags, ciphertext, and plaintext must remain in that native
adapter and never cross JavaScript or Codegen. Selection is explicit and never
downgrades to a legacy profile.

Runtime compatibility metadata remains disabled until the separate firmware,
release, and hardware gates pass; this API does not advertise device support.
Its target-facade tests and the maintenance SDK `0.0.67` runtime tests are
cross-referenced by the same canonical v2 workflow evidence in CI and tagged
release verification. The frozen public compatibility surface remains `0.0.65`.

### Native App Integration

This section describes the native-workflow compatibility route. The generated
`/runtime` catalog uses narrow OS ports; its unpublished ordered-admission
follow-up is tracked in [the catalog review](../../docs/parity/catalog-admission.md).

Current source adds `BotaDeviceSDK.recordings.listPendingRecordings(device)`.
It returns legacy recordings and v2 entries tagged by `storageFormat: 3`, with
the full UUID/generation, ciphertext length/hash and catalog metadata. Catalog
errors do not silently downgrade to legacy listing. These changes require
matching native source and a newly built application; beta.1 is insufficient.

The v2 sync method accepts a fifth argument `{ signal, operationId }`. The
optional operation ID is a fresh UUID shared with an application-native
adapter; cancellation stops and awaits that exact operation. Native provider
contexts expose an operation-scoped `readAuthNonce` callback. An RN application's
Swift/Kotlin adapter can call
`BotaDeviceSDKEncryptedUploadV2Materials.readAuthNonce(operationId)` while the
profile request is pending; it must not make a competing public BLE read.

Native material must supply `uploadContext`, which relays opaque challenge/proof
documents through the application backend. The SDK owns the bounded device
handshake before authorization and the first completion receipt. Ordinary v2
requires capability mask `0x17f`; expired-session replacement requires `0x37f`.
Neither the app nor SDK verifies backend signatures or trusts the phone clock
as a substitute for device verification. Cancellation discards late native
material via `cancelPreparation`; it does not delete recoverable recordings.
Historical checkpoints without ciphertext identity may resume the same owner
but cannot authorize replacement. See `docs/parity/v2-demo-*.md` for evidence
and limitations. Hardware and publication gates remain unchanged.

## Native Compatibility Additions

Current source follows the diagnostic and upload-recovery additions from
maintenance SDK commit `318974f925a573cf04b0d624978bee04784af09b`. These additions
are not part of the published `2.0.0-beta.1` package.

- `BotaClient.devices.readDiagnosticEvents(device)` returns a bounded batch.
  Reading does not delete it. After the application durably accepts events,
  call `acknowledgeDiagnosticEvents(device, acceptedEventIds)` with their exact
  16-character lowercase hexadecimal IDs. The native `BotaDeviceSDK.logs` API
  exposes the same methods. Firmware must support the diagnostics service.
- Configure `uploadRecoveryProvider` to refresh upload credentials for the
  original recording and account/project scope after restart. Only non-secret
  queue metadata persists; recording bytes stay in native files. Completion
  acknowledgement is required before releasing recoverable files.
- Legacy `RecordingDataStore` JavaScript byte callbacks are not supported.
  Supplying one fails configuration explicitly. Use the native file store and
  credential/completion callbacks instead; this is a migration adaptation,
  not byte-store API equivalence.

See the repository's `docs/parity/` notes for recovery contracts and test
coverage. This does not enable encrypted-v2 device support or complete the
separate physical-device and application rollout gates.

## Documentation

Published beta.15 exports `createProtectedStreamingStatusBackend` for
read-only protected STREAMING metadata. Configure a scoped HTTPS `baseUrl`,
optional `organizationId`, lifetime `signal` and fresh application
`getAccessToken`; call `getStatus({ recordingId, sessionId,
recordingGeneration, writerEpoch })`. The exact session identity is checked;
`revision` remains a decimal string and may be `"0"`. Cancel the lifetime and
call `dispose()` on workspace or account changes. A matching rebuilt native
binary is required; published beta.14 lacks these methods. `sealed` means
marker metadata only, never audio completion or permission to delete. This
reader does not start protected capture or relay signed documents. The new
generated runtime implements this read facade through its conforming HTTP port.
See `docs/parity/protected-streaming-status.md` in the source repository.

beta.15 已发布上述只读状态接口，原生适配器路径必须使用匹配的原生二进制；beta.14 不包含
这些方法。查询校验精确会话身份，revision 保持字符串且允许 `"0"`；账号或工作空间
变化时取消并释放。`sealed` 仅指标记元数据，不代表音频完成或允许删除；本接口不启动
protected 采集，也不转发签名文档。

See [docs.bota.dev](https://docs.bota.dev) for pairing, provisioning,
recording transfer, WiFi, OTA, and device-management guides.

## License

MIT

Redistribution of the generated SDK must retain
[third-party notices](THIRD_PARTY_NOTICES.md) and their complete license texts.

## Standalone migration additions (beta.6)

`BotaClient.clientPresence.nextReport(deviceId)` and
`BotaClient.devices.clientPresence.nextReport(deviceId)` return the standalone
`SdkClientContext` shape (`schema_version`, `session_id`, `sequence`, `platform`,
`sdk_package`, `sdk_version`) or null. This is passive diagnostic metadata.
The existing modern facade still returns camelCase fields, now typed as
`BotaClientPresenceContext`; callers that imported its former `SdkClientContext`
type should rename that type import. No native wire fields changed.

Use `readClientPresenceObservation` around a fresh status read and an exact host
scope guard, then attach the report and the authorized `binding_generation` to
the existing authenticated BLE heartbeat. Skip during competing work; do not
add timers, replay offline reports, or treat metadata as device authority.

For the native-adapter path, use `createUploadRecoveryProvider` with an authenticated, disposable
`UploadRecoveryBackend` lease. The helper checks identity and evidence, obtains
fresh credentials, and completes the original backend recording before native
cleanup. Supply the initial `recoveryScope` and configure the provider before
starting batch sync. Do not call backend completion only after the sync generator
returns: device confirmation has already happened then.

For legacy completion, preserve a pending response as numeric `status: 425`
with `data.error.code === 'upload_verification_pending'`. The current source
helper retries only that classification with 1–2 second jitter for two minutes;
the queue then retains completion for a later attempt without consuming its
upload-repair budget. The native journal's `completionPending` phase prevents
another PUT after restart while the backend remains pending. This phase never
permits cleanup without the exact completion ACK; only authenticated
`integrity_failure` permits a repair upload. Scope changes and cancellation
remain fenced. The host must honor request aborts and provide HTTP timeouts.
Native implementation fixes require matching rebuilt adapters. Generated-mode
consumers use `runtime.createUploadRecoveryProvider` with Rust policy and scoped
file/HTTP effects. Timers require a live JS runtime; encrypted-v2 receipt recovery
is unchanged. See `docs/parity/upload-recovery.md` for evidence and limits.

## Automatic retained uploads

Configure `backgroundSyncEnabled: false` to disable automatic retained-upload
recovery and restored-completed-file release before initialization. Explicit sync
and cleanup remain available. `resumeUploads()` only unpauses operations and does
not override that configuration; omitted/true retains automatic recovery.
Host-owned explicit auto-sync calls remain separate. See the
[admission scope and evidence](../../docs/parity/background-sync-admission.md).
