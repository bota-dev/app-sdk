# Local WiFi source checkpoint

October 29 reference firmware follow-up: the JieLi port now includes real
profile-2 GATT/HPKE/AEAD and AP/TLS/Range source, with host verification and gates
off. It requires retained original signed-token evidence; old installations need
normal token reprovisioning. The external BES port and phone interoperability
remain unverified. See [reference details](../../../firmware-local-wifi/docs/local-wifi.md).
The recovery gap recorded below is closed by the subsequent implementation checkpoint.

Historical October 29 completeness audit (resolved below): authorized successor
recovery was a software gap. The managed provider saves a replacement upload session/owner after nonce
change or expiry, but the local host passes the old recording journal directly
to the receiver. The receiver correctly rejects its old session/owner/manifest
identity. An actual generated-core probe reused a complete 330-byte file under
the same owner/new transport, but returned `integrity_failed` under a successor
session/owner with identical recording bytes. Add authorized reconciliation;
do not weaken that guard or equate same-owner tests with complete retry support.
The audit's 77 host/executor checks and eight native-asset checks pass, but do not
cover this missing path. It is tracked in the internal Protocol Contract section
9.1.4 separately from App candidate adoption and physical firmware acceptance.

October 29 lifecycle follow-up: the existing operation timeout now covers both
the actual CLOSE GATT write and the OFF wait. Expiry cancels and joins submitted
IO; it does not abandon a write Promise. The phone lease is released first, and
any shutdown failure returns `cleanup_incomplete` through the original uncertain
owner fence. A regression reproduces the formerly blocked write and verifies
bounded cancellation with retained data. The local host/native-port/v2-host/
executor suite passes 77 cases; strict RN types pass. Generated Rust/protocol
bytes are unchanged. Bota One now propagates single/batch stop/background
cancellation and waits for cleanup; this is unpublished source validation.

Managed local sync still authorizes, receives, closes the AP and publishes each
recording before proceeding. Cross-recording AP reuse is not implemented: the
current per-recording grant and cloud calls need separate lifecycle coordination.
No keepalive/renewal command or constant-on WiFi preference is added.

Date: 2026-10-24. Scope: ordinary encrypted-v2 batch only, UP-17 / SD51-12.
Unpublished branch `feat/local-wifi-sync`, based on main `3916f563`.

The canonical manifest registers service B07A000B, three characteristics,
five commands, result/evidence messages and signed channel 4. The old 24-byte
capability flags, signed document sizes, identities and receipt remain unchanged.
The internal batch request has an optional `local_wifi` carrier selector; omitted
means the original BLE path. This is SDK routing metadata, not a new wire field.

## App candidate review — October 30

An exact private SDK archive is installed in an isolated Bota One snapshot using
Node 22/npm 10 with all mandatory hooks. Android App/runtime 1.0.11 builds for
ARM64 and Android JS export passes. Actual Expo resolver/codegen evidence verifies
only the standalone WiFi IO target; the App fix below corrects the ignored-root
assumption. iOS prebuild and Podfile syntax pass, but full iOS compilation needs
Xcode. The normal repository public beta.18 pin is unchanged.

Candidate validation passes 44 local/UI/autolinking cases, 97 runtime cases
(excluding only the public-beta.18 release-pin assertion), strict types, focused
lint, license1690 and 157 dependency-security checks after a clean frozen install.
The normal source passes 98 migration and 44 local tests with its published SDK.
The private Android development client requires Metro and has not been installed
on a phone. Backend rollout, public SDK/App adoption and device/new-firmware
qualification remain separate. See internal Protocol Contract section 9.1.8.

## Authorized successor recovery — October 29 follow-up

The existing managed-upload journal now retains verified recovery parents after
`AcceptRecovery`. Rust authorizes a retained local checkpoint only for an exact
parent and current account/project/binding/recording scope. A higher owner
revision by itself is insufficient. No new device command, field, queue or cloud
recording is introduced.

After fresh authenticated PREPARED and all manifest chunks, the receiver migrates
only the upload-session/owner and session-bound manifest hash. Recording UUID,
generation, ciphertext length/hash, offset and retained prefix remain exact.
The host verifies the actual file prefix and durably saves/read-backs the migrated
checkpoint before Range or FINISH. A complete file skips GET; a partial file
requests its retained offset. Failure preserves recoverable evidence. Existing
cloud reconciliation, receipt and CONFIRM remain the only cleanup authority.

Recovery parents survive process restarts before and after checkpoint migration.
The optional journal field defaults empty for existing journals. The ancestry
bound is 64 verified replacements; exceeding it fails closed without deleting
bytes or claiming completion. An old SDK that cannot parse the extended journal
must not be used to downgrade an unfinished transfer.

Validation: 23 shared-core tests and 71 JS-binding tests pass on pinned Linux;
canonical JS source fingerprint verification, strict RN types, package build,
625 JS package/host tests and all three native-package checks pass. Four composed
managed-provider/receiver cases cover nonce replacement followed by another
process restart, partial Range, complete-file reuse, failed migration persistence
and corrupt prefix refusal. These tests found and fixed the JS decimal-string
checkpoint boundary. The CLOSE regression now waits for actual write entry
before its settlement watchdog, preserving the production deadline.

Android generated bridge compilation plus real loopback TLS 1.3/Range/pin and
joined cancellation checks pass. Apple Swift framing/pin/lifecycle checks pass;
iOS application build and device interoperability remain unqualified.

## Connected source path

The existing coordinator skips BLE checkpoint loading/truncation for local WiFi
and rejects BLE window events. The shared `LocalWifiTransferReceiver` verifies
PREPARED, bounded original manifest chunks, exact owner/file identity, retained
prefix hashes, strong ETag and exact Range responses. Each bounded append must
be flushed, hashed, journaled and read back before another append. FINISH needs
complete-file integrity and a joined HTTP reader; a complete retained file skips
AP join and GET. Neither mechanism invents a BLE sequence or delivery ledger. An older core is
refused before it can ignore the local selector and truncate a BLE checkpoint.

`JsLocalWifiTransfer` executes this policy through bounded file/BLE/network ports.
It preflights authenticated BLE and required primitives before device admission,
keeps passwords/pins/tokens ephemeral, owns cancellation and expiry, joins the
reader, releases the captured OS network, and waits for the device's OFF reply.
Failure retains the file and original owner. The original host then performs
manifest reconciliation, optional ciphertext PUT, manifest submission, finalize,
receipt and CONFIRM. Channel-4 authorization must have exactly mask 8; marked
profiles and attempts to open the BLE DATA path are rejected.

The platform port contract requires WPA2-CCMP joining, per-socket AP routing,
TLS 1.3 with the exact secure-BLE SPKI pin, token authentication, no redirects,
identity encoding and joined cleanup. There is no insecure fallback transport.
Native network components below implement these IO primitives. The complete
JS/OS bridge is implemented below; authenticated BLE proof, App adoption and
target firmware interoperability still need integration.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Allocation and strict wire codec | Manifest; `tests/local_wifi.rs` | Four codec tests |
| Durable Range/FINISH policy | `tests/local_wifi_transfer.rs` | Five shared-core tests |
| Existing coordinator/receipt reuse | Coordinator local-carrier regression | No new upload queue |
| Original authorization/receipt | JS binding planner regression | Exact channel and ordinary profile only |
| Executable host path | `jsHost/__tests__/localWifi.test.mjs` | Ten composed tests, including real Rust workflow and cloud reconciliation |
| Partial and full recovery | Prefix/hash checks, bad HTTP, readback mismatch, lost FINISH, cancellation | Host tests use simulated OS/device effects |
| Explicit SDK/managed selection | Public entry through original receipt/CONFIRM; preflight before provider; same cloud journal and channel-mismatch refusal | Source implemented; default stays BLE |
| Native phone join/TLS IO | Apple hotspot/NWConnection and Android Network/OkHttp components | Android debug/release compile and local TLS tests pass; iOS join unqualified |
| JS/OS bridge | Optional `BotaLocalWifiTransport` + `createNativeLocalWifiPort` | Source implemented; eight bridge regressions and composed public SDK path pass |
| App adoption | Permissions/UI, qualified native package and actual security verifier | Integration and phone qualification still required |
| Authenticated BLE and production firmware | External firmware team supplies agreed security mechanism and versioned test image | Phone integration and joint acceptance required; source access is not a prerequisite |
| Release and physical qualification | Production gates remain off | Not qualified |

## Public selection and provider contract

The existing public method accepts `options.transport: 'local_wifi'` (default:
`'ble'`). The managed backend accepts the same choice on its existing sync target:

```ts
await backend.sync(device, recording, {
  deviceId,
  bindingGeneration,
  transport: 'local_wifi',
  signal,
});
```

The JS runtime requires installed `ports.localWifi` and durable file ports.
It verifies the current secure BLE connection, MTU and independent capability
before requesting provider material. The provider receives the existing v2
capability plus `localWifiRawValueHex`; this is capability metadata, not a
credential. Rust plans channel 4 using `local_wifi_capabilities_base64` and the
unchanged 24-byte capability. New recording telemetry uses existing `unknown`.
The cloud journal key is unchanged: an existing other-channel session refuses
recovery rather than silently creating a second recording or changing owner.
The local file journal never goes through the BLE checkpoint/truncate branch.
Resume requires the exact saved owner/session and immutable object evidence;
this checkpoint does not claim automatic reuse after signed owner replacement.

This optional JS adapter extension uses the same public SDK method; Native
workflow Codegen/FFI/Wasm constructors remain BLE-only; the separate Codegen module supplies OS IO. Unsupported adapters reject before
provider callbacks or transfer. It does not enable background selection or
automatically install a phone network port. The optional module/factory below
provides that IO; App adoption still requires a qualified native SDK binary.

## Validation

Core/JS/FFI/Wasm regression run passes 398 tests. Core and JS all-target/all-feature clippy and strict
React Native type checking pass. The ten local host tests execute actual Rust
policy over simulated BLE, files and network. They prove source behavior only;
TLS handshakes, OS routing, target timing and power-loss behavior are not covered.

The exact canonical Linux Rust 1.98.0 / Binaryen 132 regeneration is adopted:
source SHA-256 `8b6eaa867f84cfbacf399a5e763dbf0cc904425c9ad1d0929b88b13692991925`.
The initial 601 RN tests passed against that artifact; the bridge checkpoint
below increases the suite to 610; native Rust/generated JS agree on
157 RPCs across 14 commands. Build, types, Codegen contract, protocol generation,
formatting and license checks pass. Hermes bytecode compilation and 777 Node
conformance checks pass; actual pinned Hermes VM execution remains unverified.
The first full RN run exposed a new test assertion that included connection-time
clock synchronization; narrowing it to transfer writes produced the passing full
rerun. No production code workaround was used.

Run `cargo test -p bota-device-sdk-core -p bota-device-sdk-js
-p bota-device-sdk-ffi -p bota-device-sdk-wasm`, core/JS clippy, formatting,
`cargo xtask protocol generate --check`, RN type checks and the local WiFi plus
existing encrypted-v2 host tests. Canonical JS regeneration must use Rust 1.98.0
on x86_64 Linux and preserve the generator's provenance; no generated runtime
may be patched by hand. Native ABI constructors continue to select BLE only.

The sole cross-repository completion checklist is
[Protocol Contract section 9](../../../internal-docs/device/App-Local-WiFi-Protocol-Contract.md#9-single-completion-checklist).

## Native phone IO checkpoint — 2026-10-24

WiFi association and pinned TLS clients can be implemented independently of the
BES source repository. They are now present under `platforms/apple/Sources/
BotaAppSDK/LocalWiFi` and `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/localwifi`.
These are IO components, with no second upload queue or new protocol fields.

- Apple `LocalWiFiHotspot` uses foreground `NEHotspotConfiguration.joinOnce`,
  refuses a previously app-managed SSID, and removes only its owned configuration.
  Cancellation waits for the OS apply callback before removal; it cannot silently
  dismiss the system prompt. `LocalWiFiHTTP` uses a WiFi-constrained NWConnection,
  TLS 1.3 only, exact DER leaf SPKI SHA-256 verification, identity HTTP/1.1 and
  bounded reads. Close joins submitted socket callbacks, including cancellation
  before start. Configuration removal is not proof of physical disassociation.
- Android `LocalWiFiNetwork` requires API 29+, requests a local-only
  `WifiNetworkSpecifier`, and creates readers using that captured Network's socket
  factory. It never binds the process network. Loss/cancellation closes readers
  before unregistering the owned callback; failed unregister remains retryable.
  `LocalWiFiHTTP` uses TLS 1.3 only, the exact leaf SPKI pin, no redirects/retries,
  identity encoding, bounded reads and a monotonic deadline. Blocking calls and
  joined close belong on IO workers, never the UI or network-callback thread.
- The host must derive each socket deadline from the original READY expiry,
  subtracting join time, and encode the existing 32-byte token as unpadded
  base64url. It must close readers and the captured lease on cancellation or
  foreground loss, then follow the existing device CLOSE/OFF protocol.

The subsequent bridge checkpoint below exposes these components through opaque
native handles to the generated-JS `ports.localWifi`, fences operations and
retires native resources on background/destruction. App permission/UI handling,
actual security verification and qualified package adoption remain code work.
Existing native workflow entry points stay BLE-only. The first profile remains
foreground only.

Secure BLE is a separate shared dependency. The current BLE adapter does not
prove that the exact physical connection is both encrypted and authenticated to
the authorized App/device binding. Connected/bonded/provisioned flags cannot
replace that proof. Keep preflight rejecting until the shared phone/firmware
security mechanism exists; this change adds no ad-hoc crypto or bypass.

The App must supply Hotspot Configuration entitlement and local-network usage
permission on iOS, and the appropriate WiFi/network manifest permissions and
runtime permissions on Android. In particular, the existing BLE library's
location declaration capped at API 30 does not cover WiFi on API 31–32; the App
must explicitly reconcile its merged manifest. Consult the official
[Android WiFi permission rules](https://developer.android.com/develop/connectivity/wifi/wifi-permissions),
[network request API](https://developer.android.com/develop/connectivity/wifi/wifi-bootstrap)
and [Apple temporary hotspot behavior](https://developer.apple.com/documentation/networkextension/nehotspotconfiguration/joinonce).
No App manifest or published package pins are changed here.

Validation: Android Gradle debug/release Kotlin compilation passes against API
36 with the repository's strict compiler settings. The new public API blocks
are copied from generated `apiDump`; unrelated pre-existing API-baseline drift
is preserved, so this is not a claim that the full API baseline gate passes.
`tools/local-wifi/check-transports.py` generates temporary EC and RSA keys, then
checks exact SPKI extraction/mismatch, HTTP framing and 100 pre-start cancellation/
close cases per certificate on Apple. Android uses a real loopback TLS server to
verify successful/bounded reads, Range/If-Match, wrong-pin and TLS-1.2 rejection,
no redirect following, malformed framing, and cancellation during headers/body.
All component checks pass for both key types. Keys are removed after each run.

Apple checks compile with Swift 6 on the macOS SDK. No iOS SDK/Xcode is installed,
so iOS HotspotConfiguration compilation and real iOS TLS routing remain open.
Android API compilation and JVM TLS checks do not establish Android OS callback,
permission-prompt or physical routing behavior. Both platforms still need
foreground/background, permission refusal, AP loss and real BES acceptance.

Reproduce with JDK 17, Android API 36, cached pinned Gradle dependencies, OpenSSL
and Apple Command Line Tools:

```sh
python3 tools/local-wifi/check-transports.py --platform both
```

Set `JAVA_HOME` and `ANDROID_HOME` for the installed tools. The runner performs
no dependency downloads, uses loopback only and never joins an actual hotspot.

## Delivery ownership clarification — 2026-10-24

The production firmware is maintained by another team, outside our `firmware`
repository. Existing reference code is preserved as historical evidence and is
not a production port or a prerequisite for SDK completion. Our next code work
is permission/lifecycle/App wiring and the phone side of the agreed security
mechanism, followed by target/package validation
and backend integration. Simulated-peer and loopback checks proceed independently.
No security success is fabricated while the device-side mechanism is unconfirmed.

The sole task/acceptance checklist remains internal Protocol Contract section 9.
It now assigns our work, external firmware work and joint acceptance separately.
Handoff supplies exact fields, fixtures, sequences and failure/ownership rules;
the external team supplies compatibility feedback, security details and a versioned
test image. Their source repository is not required. No reference firmware source
is changed or reverted as part of this ownership clarification.

## Generated-JS/native OS bridge checkpoint — 2026-10-24

`createNativeLocalWifiPort` now adapts the optional `BotaLocalWifiTransport`
TurboModule to the existing local carrier. `/runtime` stays free of React Native
runtime imports and native workflow engines. The original native distribution
registers the OS module on Android and iOS; this requires a rebuilt native App,
not a JS-only update to an older installed binary. Existing workflow ABI and
protocol bytes are unchanged.

The native registry owns at most one lease and one immutable reader. An allocated
handle exists before association, so cancellation can retire a pending join.
Late acquisition is closed; late read results are rejected after reader/lease
retirement. Close joins submitted work before resolving, cannot affect a newer
handle, and retains a failed cleanup for retry. Entering background or module
destruction retires the captured native lease. Re-admission rejects an occupied
lease before cloud-provider work. Android preflight checks foreground state and
permissions; iOS enforces foreground state and still needs App entitlement and
local-network permission configuration. Neither bridge manufactures BLE trust.

Bridge JSON carries only ephemeral connection material and bounded metadata;
recording ciphertext reads are bounded to 64 KiB, base64 only within the internal
bridge. No credentials or raw response errors are logged/persisted. The native
monotonic deadline subtracts time spent preparing/joining; pins and tokens retain
exact original wire meanings. Shared Rust still owns Range/ETag/integrity,
FINISH and upload/receipt policy.

Host installation after native package qualification:

```ts
import { TurboModuleRegistry, type TurboModule } from 'react-native';
import {
  createNativeLocalWifiPort, type NativeLocalWifiTransport,
} from '@bota.dev/react-native-app-sdk/runtime';

const localWifiOS = TurboModuleRegistry.get<NativeLocalWifiTransport & TurboModule>(
  'BotaLocalWifiTransport',
);
ports.localWifi = createNativeLocalWifiPort(localWifiOS, {
  assertOwner: (peripheralId, context) =>
    appScope.assertCurrentConnection(peripheralId, context),
});
```

`appScope` fences the current account/binding/physical connection owner. It does
not establish cryptographic trust. Mandatory profile 2 now performs the concrete
signed-HPKE control grant and AEAD QUERY/idle proof inside the shared SDK before
any PREPARE or hotspot secret reaches this native IO boundary.
The bridge checks App ownership before admission and again before a lease.
Missing module or verifier fails closed. The App requests permissions before
sync and connects its existing lifecycle/connection cancellation to the supplied
context; its UI and actual binding-security adapter remain unfinished.

Verification: eight JS bridge regression groups plus ten local workflow groups
pass, including the public SDK -> bridge -> shared Rust -> original cloud
reconciliation/receipt/CONFIRM path over simulated device/native effects. The
full RN suite passes 610 tests. Types, build, Codegen regeneration/contract,
package metadata and license checks pass. A regression first reproduced late
success after explicit close, then passed after result fencing. Android's actual
module compiles with the generated Java spec, React Android 0.86.3 and API 36.
Swift 6/macOS compiles the bridge and passes injected-association tests for stale
handles, delayed join cancellation, cleanup retry, busy/background admission and
invalidation. EC/RSA loopback TLS checks remain green. Run:

```sh
python3 tools/local-wifi/check-transports.py --bridge
```

These checks do not replace an iOS SDK/ObjC++/CocoaPods build, an assembled
React Native Android consumer, real system callback/permission/routing tests,
App adoption, or the actual security and external-firmware acceptance gates.
The Rust generated runtime was unchanged by this bridge-only work.


## Standalone native IO and first-party App checkpoint — 2026-10-25

Bota One already runs the generated JavaScript SDK and disables the full native
workflow package. Linking that package to obtain WiFi IO would reintroduce
unneeded native workflows. The optional `/native-io` build configuration selects
only `BotaLocalWifiTransport`, using the same canonical network and bridge
sources. It adds no BLE owner, upload queue, protocol field or Rust binary.
The default full-native entry remains unchanged; never link both targets.

For a qualified package, a generated-JS consumer selects this dependency in its
`react-native.config.js` before rebuilding its native binary:

```js
module.exports = {
  dependencies: {
    '@bota.dev/react-native-app-sdk': require('@bota.dev/react-native-app-sdk/native-io'),
  },
};
```

Correction from the October 30 actual App build: Expo ignores the dependency
`root` override and an iOS `podspecPath` override. The direct configuration above
therefore does not select the standalone target with Expo. Bota One sets Android
`sourceDir: 'native-io/android'` relative to the npm package, disables SDK iOS
autolinking and uses its `with-local-wifi-transport` Podfile plugin to add only
`BotaLocalWifiTransport` from that directory. The plugin is conditional on the
installed SDK capability and idempotent. Keep the full native SDK disabled.
The standalone root contains
only the local-WiFi Codegen spec, pod and Android package. Eight packaged source
assets are exact generated copies: edit canonical sources, run
`node frameworks/react-native/scripts/prepare-local-wifi-native.mjs`, then verify
with `--check`. The normal RN build and a package regression reject stale copies.

The target supplies Android manifest declarations. The App must request Nearby
WiFi Devices on API 33+ (the current App targets API 36), or fine location on
API 29–32. API 26–28 remains supported for existing App behavior but cannot use
this local association API. iOS still needs the Hotspot Configuration entitlement
and local-network usage description in its rebuilt host. Permission grants do
not prove authenticated BLE or authorize a file.

The isolated Bota One `feat/local-wifi-sync` source (main baseline `4cd189f`)
adds an explicit third transport argument to single/batch sync hooks and forwards
it to the existing encrypted-v2 adapter/backend. Its public beta.18 pin stays
unchanged. An older SDK lacking the local bridge factory refuses before API work;
legacy/mixed local batches refuse before device/cloud work. No automatic
local-to-BLE/direct retry is added. The selected SDK still must validate secure
BLE and firmware capabilities before provider admission.

App permission handling now runs inside the captured API scope, rechecking
cancellation/foreground after the OS response. Permission denial or a scope
change stops before creating the managed backend. The existing host lifecycle
signals remain in use. This is source orchestration: the actual secure-link
adapter, host installation/entitlements and user-facing entry are still pending.
No SDK dependency pin, App version or shipping native configuration was changed.

Verification for this checkpoint:

- 613 RN checks, strict types, build, Codegen contract and package metadata pass.
- Historical archive-resolution checks did not establish actual Expo target
  selection. The October 30 App build exposed the ignored-root defect and the
  App configuration above corrects it. Actual Expo resolver tests now verify the
  WiFi-only Android path and excluded full iOS pod; prebuild verifies the explicit
  standalone iOS pod. Eight archived assets match canonical sources.
- The standalone Android debug AAR, strict lint and minimal consumer APK build
  pass against React Android 0.86.3/API 36. The AAR contains no native workflow
  or UniFFI classes, and its generated schema contains exactly one WiFi module.
  An API-29 guard was made explicit for lint. Only version-availability advice
  is disabled for repository-pinned dependencies; exact-SPKI trust has a scoped
  documented lint exemption, with wrong-pin/TLS downgrade tests retained.
- Swift 6/macOS compiles and runs lifecycle tests both with the existing module
  import and as a standalone target without `BotaAppSDK`. EC/RSA component and
  Android generated-spec/registration compile checks pass.
- Bota One's local-WiFi command passes 32 tests (including single/batch hook
  execution), and its migration command passes 98 tests. Existing encrypted-v2
  HTTP and direct-upload handoff suites pass. App types pass with both the pinned
  public package and the candidate declarations.

Reproduce package/autolinking and Android checks:

```sh
node tools/local-wifi/check-native-package.mjs --consumer /path/to/installed/bota-one
platforms/android/gradlew -p tests/conformance/react-native-local-wifi-android \
  :transport:assembleDebug :transport:lintDebug :app:assembleDebug --no-daemon --no-parallel
```

The APK is a minimal compile/packaging fixture, not a functional Bota One build
or an installed-device test. Release AAR resolution first failed offline because
the release React Native artifact was absent; only the debug consumer is verified.
iOS SDK/ObjC++/CocoaPods, actual permission dialogs/routing, protected BLE, App
adoption, backend deployment and external firmware acceptance remain separate.
No compound-engineering skill was available; the requirements above were checked
directly against Protocol Contract section 9 (the sole completion checklist).

## Minimal control security checkpoint — 2026-10-29

The [complete wire/security contract](../../protocol/local-wifi-control-v1.md)
replaces the previous undefined secure-link integration dependency. Profile 2
requires flags 31 and existing signed-blob kind 7 (509 bytes). Shared Rust derives
separate App/device AEAD keys and enforces session/direction/counters. The JS host
installs original upload authorization first, reads a fresh nonce through the
managed provider, installs the new grant and requires encrypted QUERY/idle before
PREPARE. All local CONTROL/EVENT frames carry the 20-byte protected wrapper.
Original manifest/receipt authority and local durable-file reuse remain unchanged.

Our backend reuses enrolled identity and its signed HPKE primitive. Bota One
source adds the authenticated proxy, optional IO autolink, current-owner callback,
local WiFi entry, iOS entitlement/usage text and appVersion 1.0.11. Its published
SDK pin remains beta.18, which keeps this entry unavailable until a qualified
candidate is adopted. External firmware ownership and default-off rollout remain.

Final local source evidence: 400 Rust tests across core/JS/FFI/Wasm and core/JS clippy;
620 RN tests (no skips), build/types, Codegen and source provenance; 162 matching
native-Rust/generated-JS RPCs including the real signed-HPKE interoperability
vector. The canonical Rust 1.98 x86_64 Linux generator produced the checked-in
JS core. New Rust dependency notices are included; all 32 normal Rust
dependencies and the existing npm license gate pass. Packed npm runtime passes Bota One's actual installation source, owner
retirement and existing BLE-port preservation, with Expo iOS/Android native IO
resolution. App types pass against both the published SDK and candidate types.

Backend focused/OpenAPI checks pass 103 cases; the 41 EndUser contract cases use
an isolated Git fixture of the reviewed current semantic sources because the
working branch remains uncommitted. No project HEAD/index was changed. The new
route is in the internal OpenAPI inventory only. Existing 27 route/cache checks
also passed earlier. App checks pass 34 local-WiFi, 98 migration/lifecycle and 25
proxy cases. Authentication failure now cancels an in-flight read; acknowledged
local shutdown retires its key/timer before independent cloud receipt handling.

These are source, generated-artifact and simulated-peer/package checks. Published
SDK adoption, a new Bota One binary, backend deployment, iOS target compilation,
actual phone routing and external firmware implementation/acceptance remain.
Production issuance stays disabled; the installed beta.18 App remains BLE-only.
