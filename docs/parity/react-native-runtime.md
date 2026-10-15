# React Native generated JavaScript runtime and OTA boundary

October 12, 2026 source migration. Shared SDK behavior remains Rust-sourced.

Unpublished beta.19 targets the physical backlog and lifecycle failures below.
Shared Rust batches buffered contiguous legacy DATA within 32 KiB; the JS
executor joins submitted work before terminal cleanup and scan startup before
subscription removal. Rust ignores only matching queued scan callbacks while
awaiting StopScan. Existing OS ports, identity fences and confirmation rules
remain unchanged. Canonical generation and all nine exact candidate branch CI
jobs/License pass, including 486 RN tests, 136 Rust/JS RPC comparisons and 715
pinned Hermes checks. All 49 preserved files, five identities and 59 Flutter
files verify. Two candidate Android connections and joined teardown pass without
a Bluetooth reset,
but a newly observed receive gap still prevents full transfer. One's local busy
read/disconnect guard fix awaits UI retest; normal Demo sync is running. Full app
acceptance, final-main CI and publication remain pending. See the
[preflight](../../release/evidence/2.0.0-beta.19-preflight.md).

Published beta.18 corrects connected BLE PLX MTU observation under the original
package identity. Exact main CI/License, protected release attempt 2, public
generated-runtime/native consumers and all 59 Flutter files pass. A normal
public beta.18 bundle reads identity/status/catalog at MTU 512 in One's existing
Android host. The later controlled capture passes START/STOP but demonstrates a
legacy transfer backlog failure and uncertain SDK teardown; full sync is failing.
The original pending cloud pointer and failed queue remain preserved. See the
[physical follow-up](#october-14-android-physical-follow-up-october-15-utc).
App OTA and full platform/background acceptance remain separate. See
the [publication review](../../release/evidence/2.0.0-beta.18-publication.md).

Published beta.17 adds `isEmptyLegacyAndroidV2CheckpointCatalog(bytes)` on
`/runtime`. Generated Rust admits only the exact 12-byte empty catalog left by
the old Android SDK after successful cleanup. Hosts supply the complete short
file or a complete 13-byte prefix for longer files; every other encoding remains
protected migration evidence. This neither imports pending native state nor
authorizes deletion. Apple successful cleanup removes its sidecar/file; no
empty Apple catalog exists. The BLE manager contract also admits a nullable
disconnect device, matching pinned `react-native-ble-plx` 3.5.1; a strict real
library assignment regression requires no cast. Exact main `b8a31c5`, all nine
CI jobs/License, 715 pinned Hermes checks and all five public package/consumer
gates pass. See the
[beta.17 publication review](../../release/evidence/2.0.0-beta.17-publication.md)
and historical [preflight](../../release/evidence/2.0.0-beta.17-preflight.md).
React Native runs generated executable JavaScript over versioned installed OS
ports. Package publication, app OTA delivery and physical acceptance are separate
gates; published npm execution does not establish installed-app or device acceptance.

October 13 naming decision: release this route through the existing
`@bota.dev/react-native-app-sdk/runtime` entry in beta.16. Its approved public npm
bytes and fresh generated-runtime/declaration consumer are verified. Exact-main
nine-job CI/License and protected release attempt 2 pass all five publications,
public JS/declaration/native consumers and complete Flutter verification. The companion is a
private source fixture; the separate registry/publication plan is withdrawn.
See the [publication review](../../release/evidence/2.0.0-beta.16-publication.md)
and historical [preflight](../../release/evidence/2.0.0-beta.16-preflight.md).

## October 14 Android physical follow-up (October 15 UTC)

Public beta.18's original `/runtime` runs in the unchanged One 1.0.10 Android
host. Fresh scope/binding generation 4, the exact selected Pin, firmware 1.0.18
and MTU 512 were verified. Fresh batch mode (`streaming_enabled=false`), WiFi
unavailable and BLE before cellular admitted one continuous-connection capture;
START and STOP were accepted and stopped state was verified. Its legacy catalog
advertised 207,872 bytes (rounded to KiB) and 48 seconds. The known test clip was
not played, so this provides no audio-quality acceptance.

Standalone transfer received 400 consecutive DATA packets (500-byte payloads,
no gaps, duplicates or length mismatches). 142 appends reported durable completion
(71,000 bytes); one further append was submitted. The remaining 257 packets hit
the Rust receiver's 256-packet backlog bound, below its 128 KiB byte bound,
causing `integrity_failed` before EOF, CRC verification or finalization. This
proves the backlog failure for this capture; the earlier uninstrumented failure
does not establish the same cause. The original failed queue/cloud pointer
remained unchanged, with no app recording create, PUT or device CONFIRM.

Disconnect and destroy reported `operation_in_progress`. Source shows terminal
discard can contend with its own submitted append, and cleanup failure retains
the SDK operation owner. The append had settled by the terminal observation;
retained OS GATT ownership was not observed. A phone Bluetooth cycle allowed one
reconnect, while the next failed with `unexpected_event`; stable reconnection
remains unverified at that published baseline. Full sync fails; cloud commitment
and durable completion remain unverified. The unpublished beta.19 source adds
the bounded batching, same-sink cleanup and scan corrections, with candidate
results below; beta.18's occupied artifacts remain unchanged.
See the [mobile migration review](https://github.com/bota-dev/internal-docs/blob/main/test/2026-10-13-generated-js-mobile-migration.md).

## October 15 unpublished beta.19 Android candidate

The exact packed candidate at `ce087f88` uses the original `/runtime` entry in
One 1.0.10's existing Android host. The app manifest and installed SDK package
remain beta.18; a temporary explicit override selects the reviewed beta.19
archive. No native host rebuild, public beta.19 installation or app OTA is implied.
Two fresh exact-serial connections complete, first for metadata and then capture,
without a phone Bluetooth reset. Both verify current scope/binding generation,
firmware-reported 1.0.18 and MTU 512, and join disconnect/destruction successfully.

Fresh batch/connection policy permits one START and one STOP with fresh nonce
grants; stopped state is verified. A known synthetic input plays twice during
capture, while recorded microphone content and quality remain unverified.
The new post-STOP legacy catalog advertises one 208,896-byte/49-second file.
Transfer receives 29 DATA packets totaling 14,500 payload bytes, with sequences
0–27 followed by 29. The diagnostic port observes the missing sequence 28 before
Rust dispatch, so this is an upstream delivery gap, not evidence that Rust
batching dropped a received packet. Firmware versus Android/native attribution
remains unproven. Seven appends report 14,000 durable bytes and last sequence 27;
no EOF, finalization or CRC verification occurs. Integrity rejection sends
NACK1/ACK0/CONFIRM0. Diagnostic sink discard and checkpoint removal each complete
once; disconnect and destroy now both pass after the failed transfer.

The original failed queue/retry 0 and exact pending cloud pointer remain unchanged
without size/hash. No app recording create, PUT, upload or device CONFIRM occurs.
Private capture correlation is retained; legacy aliasing does not prove exact
cross-channel identity. New source presence and autonomous cloud outcome after
disconnect remain unknown. Normal One home/auth/list/device navigation opens,
but a false disconnect under its busy read loop is identified. Its local guard
fix passes focused tests and strict types; normal UI retesting remains pending.
Normal Demo's fresh session/cloud list and selected-test-device BLE connection
pass, and normal Start/Stop buttons plus two known input playbacks succeed.
Manual Pending recordings Sync is running; transfer, captured content/codec and
cloud commitment are not yet verified. These observations do not establish the
requested complete normal-app recording acceptance. See the
[candidate evidence and remaining gates](../../release/evidence/2.0.0-beta.19-preflight.md).

## Source and distribution

`core/device-sdk-core` supplies canonical codecs, reducers and workflows.
`bindings/device-sdk-js` provides the bounded JSON/u32 bridge and Rust host
planners, including managed upload and BYO decisions. The locked generator
compiles Rust 1.98 to an intermediate Wasm module and lowers it with Binaryen
132.0.0 into ordinary JavaScript. Applications execute JS and typed arrays,
without WebAssembly support or a native Rust engine.

The generator preserves numeric compiled function boundaries through
`Object.freeze`. Their bodies and parameter text stay unchanged; initialization
retains hoisting and instance captures. This avoids a pathological Hermes
control-flow optimization while retaining normal `-O` and default parser limits.

`frameworks/react-native/src/jsHost/generated/core.ts` is a committed executable
artifact with source provenance. The generator's `--check` rebuilds exact sources;
`--provenance-only` checks them without a compiler. Regeneration belongs to
maintainers/CI. Bundling the generated JavaScript uses the committed artifact
without Rust regeneration. Initial or changed OS ports and native compatibility
integration still follow the application's normal Gradle/Xcode build process.

Exact generation uses the canonical Rust 1.98.0 compiler host
`x86_64-unknown-linux-gnu`, matching CI. Cargo includes build-host metadata in
target crate identities, and embedded source paths also differ across hosts.
Other hosts use the committed portable JS and `--provenance-only`; they do not
produce a competing artifact. CI always rebuilds and compares the complete
artifact, rather than substituting a source-hash check.

The public route is `@bota.dev/react-native-app-sdk/runtime`, a separately
loadable subpath of the original package. The whole package retains native
adapters, frozen compatibility exports, React Native peers, Codegen and
autolinking. Importing the subpath evaluates without native module imports or
registry access; it does not disable package autolinking.

The private `frameworks/react-native-runtime` fixture compiles the same facade
and generated artifact with structural declarations and Buffer/EventEmitter
dependencies. Its internal identity/version supports source checks only; it is
not an npm publication or application installation target.

An app choosing generated mode can exclude the bundled Bota native adapters
through its app-side `react-native.config.js` before the app build:

```js
module.exports = {
  dependencies: {
    '@bota.dev/react-native-app-sdk': {
      platforms: { ios: null, android: null },
    },
  },
};
```

Generic host libraries still supply the installed OS ports. The native
compatibility factory requires linked adapters; importing `/runtime` alone does
not disable linking. This is the
[documented CLI option](https://github.com/react-native-community/cli/blob/main/docs/autolinking.md#how-can-i-disable-autolinking-for-unsupported-library),
with installed-app and physical qualification still pending.

Select the generated path with `createBotaReactNativeJsRuntime`. The legacy
`createBotaReactNativeRuntime({ apiVersion: 1, device, ... })` still accepts
installed full-workflow adapters with their existing native responsibilities.
That legacy path does not substitute for the generated path's OS-port contract.

## Installed OS ports, API version 1

```ts
import {
  createBlePlxPort,
  createBotaReactNativeJsRuntime,
  type BotaJsHostPorts,
} from '@bota.dev/react-native-app-sdk/runtime';

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
  lifecycle: installedLifecycle,
};
const runtime = createBotaReactNativeJsRuntime(ports, {
  backend: { fetch: redirectRefusingHttps },
  uploadFile: uploadOpaqueFile,
  openSocket: openAuthenticatedSocket,
});
await runtime.client.configure({ environment: 'production' });

// On logout, project/device reassignment or teardown:
lifetime.abort();
await runtime.client.destroy();
```

Named host values implement the exported structural interfaces and perform OS
I/O rather than complete Bota workflows. JS can implement them through installed
libraries. Bluetooth, durable files, secure randomness and background execution
use OS facilities installed in the app binary. `createBlePlxPort` adapts a generic
`react-native-ble-plx` manager without the native Bota SDK. The host owns permissions
and manager lifetime.

| Port | Required behavior |
| --- | --- |
| BLE | Scan, connect/discover/disconnect, read/write and notifications; propagate errors; cancel and join submitted I/O; provide ATT capacity and physical disconnect observations for protected workflows |
| Persistence | Capture one account/project/user/environment namespace; atomically save private durable journals with readback; retain that namespace during cancellation |
| Files | Reopen scoped logical files after restart; bounded reads, exact durable append/truncate, metadata and CRC finalization; explicit flush is required for protected/BYO persistence |
| Randomness | Return exactly the requested number of cryptographically secure bytes |
| HTTPS | Refuse redirects before forwarding credentials/data, omit ambient cookies, honor aborts/timeouts, bound responses and preserve exact status/identity |
| File upload | Upload the captured opaque file with validated method/headers; join cancellation and report progress without changing owner |
| WSS | Optional qualified BYO relay; preserve `bota-byo-stream-v1`, authentication/binding headers and bounded messages; close cancels and joins sends/receives |
| Lifecycle | Report foreground/background/suspended state; claim background execution only when the installed host can actually run and settle JS work |

Default React Native XHR-backed fetch does not provide the required pre-redirect
credential fence. `redirect: 'error'` is insufficient when an implementation
ignores it. Supply a conforming installed HTTP transport. Initial unavailable
WSS can use the qualified HTTP segment mode; established socket loss follows
Rust's three-reconnect and fenced full-file recovery policy.

Construction checks API version and primitive shapes before OS effects. Optional
feature absence fails before dependent device work. Method presence does not
prove installed-host durability or cancellation. Each runtime captures its ports
and scope; create a replacement after scope changes rather than mutating active
methods or namespaces.

The generated factory currently supports one configured lifetime. A second
`runtime.client.configure()` releases its manager graph and destroys the core,
then rejects with `runtime_destroyed`; a controlled generated-factory probe
confirms this even for identical configuration. The compatibility facade's
reusable-instance reconfiguration test does not prove generated parity. Apps
must make same-scope configuration idempotent and construct a fresh runtime
after retirement; this is the consuming integration's lifecycle contract for
the current migration. Reusable generated-instance parity remains a separate
SDK limitation rather than an acceptance claim.

## Shared decisions and resource ownership

Generated Rust chooses wire framing, identity/capability admission, transfer
windows, durable checkpoints, repair, backend recovery, retry policy and cleanup.
JS translates the public API, executes effects and joins resources. Source paths
cover discovery/connection, controls/diagnostics, provisioning/reset, recording
and streaming transfers, managed v2/markers, BYO and firmware workflows.

The executor retains one exact operation, cancellation and runtime generation.
GATT uses one ordered lane; timers/persistence can settle independently of blocked
GATT. Cancellation joins work, callbacks, subscriptions and cleanup before a new
owner is admitted. Uncertain cleanup retains ownership. Confirmed retired
connections close captured subscriptions without replaying old commands.

Connection adoption preserves the retired RN setup behavior: a generated UTC
clock write settles before publishing the connection, while settled legacy
firmware rejection remains best effort. Cancellation, scope loss and uncertain
cleanup still fail adoption. The generic BLE driver requests the canonical MTU
and observes the current exact connection for up to ten attempts, 200 ms apart,
using Rust-declared bounds. Stale disconnects and MTU observations cannot mutate
a replacement connection.

October 14 Android acceptance found that BLE PLX `devices()` reads its scan
cache, where MTU can be null even after a successful 512-byte negotiation.
The corrected OS adapter obtains capacity through the connected
`requestMTUForDevice` result with a captured, cancellable transaction. Identity,
physical-generation and Rust retry bounds remain enforced. The regression
reproduces beta.17's `invalid_mtu` failure before this source correction; package
publication and the resumed physical test remain separate gates.

Optional `readBluetoothState` and `observeBluetoothState` ports expose the OS
radio and permission state. Generated Rust normalizes those observations for
`runtime.client`; the generic BLE adapter supplies both. A host without state
observations remains `unknown` and cannot satisfy `waitForBluetooth`. Scope loss
and destruction join state reads, observer setup and removal; retired callbacks
cannot revive the client. Failed construction releases every created owner before
disposing the generated core.

Live BYO admits Stop Recording and its required nonce/state reads through Rust's
exact allowlist. Other controls remain exclusive. Stream ACK releases RAM only.
PUT, a legacy `uploaded` flag or reconnect cannot authorize deletion. Cloud
commitment, verified receipt, durable save and device confirmation stay separate.
See [BYO](byo-storage.md), [managed v2](v2-managed-backend.md) and
[upload recovery](upload-recovery.md).

Generated firmware update uses the canonical Rust OTA/reboot-recovery loop.
`firmwareRecovery.timeoutMs` can shorten its shared post-verification budget;
there is no second TypeScript recovery loop. `firmwareRecovery.delayMs` applies
to the legacy full-adapter fallback only. Completion requires fresh exact serial
and installed-version readback. Transfer or CRC failure cannot enter reboot
recovery; an ACK does not prove the installed version.

The shared workflow allows 30 seconds for the device's Ready and Verify responses
after the corresponding write settles. An early valid response is retained; a
write acknowledgement alone cannot advance verification. The shared reconnect
budget remains two minutes unless the caller narrows it.

Factory reset similarly preserves an exact successful result received before the
opcode write callback. It saves that result, waits for the original write and
the application's durable acknowledgement to settle, then sends the receipt.
Late write failure cannot discard already proven physical success or authorize a
second reset. Receipt-only recovery uses the retained result and sends no grant.

## Internal transport material and custom providers

Ciphertext and signed authorization/context/manifest/receipt documents can be
bounded internal JS SDK transport values. Public APIs return metadata, progress
and results. V2/BYO private signing/decryption keys remain on the device; host
private-key operations stay behind installed secure handles. JS gains no signing
or decryption authority. The historical caller-supplied private-PEM import API
is a compatibility gap outside the modern non-exportable key target and must
not define new admission or provisioning.

`runtime.createEncryptedUploadV2Backend(options)` supplies managed scoped HTTP
and material integration. Custom providers use an operation-scoped nonce and
JS material registration:

```ts
await runtime.sdk.recordings.syncEncryptedRecordingV2(
  device,
  recording,
  async request => {
    const nonce = await runtime.readEncryptedUploadV2AuthNonce(request.operationId);
    const prepared = await yourBackend.prepare(request, nonce);
    const materialRegistrationId = runtime.registerEncryptedUploadV2Material(
      request.operationId,
      prepared.material,
    );
    return {
      profile: 'encrypted_upload_v2',
      uploadSessionId: prepared.uploadSessionId,
      ownerRevision: prepared.ownerRevision,
      securityPolicy: 'v2_required',
      materialRegistrationId,
    };
  },
);
```

`prepared.material` implements `JsEncryptedUploadV2Material`: authorization,
physical context exchange, scoped staging/manifest/marker submission, verification
and final receipt, plus cancellation/confirmation callbacks. It retains bounded
documents or opaque file handles and calls the authenticated application backend.
It supplies no native Bota workflow or local trust authority. Registrations belong
to the pending operation and captured physical owner; late/foreign material is
rejected. Release unused registrations with `releaseEncryptedUploadV2Material`
and honor captured signals. Use `runtime.createUploadRecoveryProvider` for
generated compatibility recovery policy; the legacy standalone helper retains
older adapter behavior.

## Verification and delivery gates

| Requirement | Check mechanism | Current gate |
| --- | --- | --- |
| Rust produces ordinary executable JS | Canonical beta.17 regeneration, 106 matching inputs, 136 native/generated RPC comparisons and shared Rust tests | Matched in exact-main CI at `b8a31c5` |
| RN engine compatibility | 715 Node VM checks and pinned Hermes execution with normal optimization in exact-main CI | Matched source/compiler/VM gates; installed-app acceptance separate |
| Primitive-only generated mode | Fresh public beta.17 install configures/destroys the original `/runtime` generated client with native imports, registry access and WebAssembly rejected; strict declarations compile | Matched public consumer in protected release attempt 1 |
| Public API and feature/recovery parity | 479 RN tests including frozen contracts, managed root routing, exact legacy-empty admission and real nullable BLE library types | Matched source gate; documented maintenance/security gaps remain |
| Runtime lifetime across scope changes | Real generated A → B → A fresh-factory configure/recovery/destroy cycles; late callbacks remain fenced | Fresh-factory route matched; same-client reconfigure remains partial |
| Preserve unresolved old native work | Exact 12-byte empty catalog classifier is generated Rust; pending/unknown artifacts stay protected | Classifier matched; automatic pending-state migration not implemented |
| Scoped durable receipt cleanup | Requirement/evidence reviews and injected host failures | Installed durability and physical acceptance unverified |
| Published beta.18 Android legacy transfer | Controlled capture and bounded packet/append metadata above | Failed at the 256-packet backlog bound; occupied public artifacts unchanged |
| Unpublished beta.19 source/runtime | Canonical generation; all nine exact branch CI jobs/License; 486 RN tests, 136 RPC comparisons, 715 pinned Hermes checks; 49 preserved files/five identities/59 Flutter files | Matched branch candidate gates; final-main CI/publication pending |
| Unpublished beta.19 Android transfer/lifecycle | Two connections without radio reset; missing sequence rejected; joined failure teardown passes; normal One guard/Start/Stop pass and new local size/SHA match retained queue | Partial: normal One upload fails with cancellation; Demo has no verified new cloud result; complete sync/device cleanup remain open |
| Redistribution notices | Exact public RN archive contains all 47 notices and generated runtime/declarations; source license gates and private fixture checks pass | Matched public archive and source checks |
| npm publication and application OTA | Exact approved RN/Web bytes are public; initial OS-port installation and app rollout remain separate | npm matched; app OTA and physical acceptance unverified |

The exact generation provenance, compiler proof and source checks are recorded in
[the migration review](../superpowers/plans/2026-10-12-react-native-generated-js.md).
Beta.17 canonical generation and Apple/Flutter preparation are verified in the
[preflight](../../release/evidence/2.0.0-beta.17-preflight.md), with 106 matching
generator inputs, 479 fresh RN tests, 715 actual Node VM checks and strict source
consumer/declaration checks. Exact-main nine-job CI/License, immutable source/tag,
49-file inventory and public npm/runtime results are recorded in the
[publication review](../../release/evidence/2.0.0-beta.17-publication.md).
Synchronized publication is complete; app and device acceptance remain separate. The
earlier TypeScript-adapter milestone's 227 RN tests remain historical evidence.
Hardware, customer proxy/TLS,
OS background behavior and deployed app OTA require separate acceptance evidence.
