# BYO customer storage integration

The native descriptions below concern the installed Apple/Android path. The
October 12 generated JavaScript source migration is reviewed in the final
section; its package delivery and physical acceptance remain separate.

October 10 unreleased source. Apple, Android and React Native connect both live
and whole-file BYO uploads to the independent firmware protocol. New live entry
points use qualified HTTP segments/WS and fenced Batch completion. Firmware,
backend gates, customer endpoint qualification and matching native binaries are
required; this is not a claim of published package or physical acceptance.

## Application integration

```ts
import { createByoStorageBackend } from '@bota.dev/react-native-app-sdk';

const lifetime = new AbortController();
const uploads = createByoStorageBackend({
  baseUrl: 'https://your-backend.example/v1',
  scopeKey: 'production/account/project/user',
  organizationId, projectId, environment: 'production',
  signal: lifetime.signal,
  getAccessToken: signal => getCurrentAppAccessToken(signal),
});
const target = { deviceId, bindingGeneration };
const recordings = await uploads.list(device, target);
for (const recording of recordings) {
  const result = await uploads.sync(device, recording, target);
  // result contains recordingId and uploadSessionId only.
}
// Also invoke sync for the same identity after reconnect/restart.
// On logout, scope change or teardown:
lifetime.abort();
await uploads.dispose();
```

The customer proxy authenticates the app user, constrains device access and
forwards the existing physical-context routes plus
`/v1/devices/{deviceId}/byo-uploads` and `/byo-streams` under a server-held project/restricted key. The stream proxy must also forward WSS `/byo-streams/ws`, authorization/binding headers and subprotocol `bota-byo-stream-v1`.
`X-Bota-Device-Binding` is mandatory. Never put a Bota secret API key in the app.
Apple/Android expose `recordings.listByoRecordings` and `syncByoRecording` with
`ByoStorageOptions`; direct hosts supply private state storage, fresh credentials
and a current-scope validation callback. The host owns reconnect/sync scheduling.

No customer selection returns the typed `not_selected` outcome before BYO
ownership. Hosts can then select their existing Bota upload adapter. Once selected
intent is durable, customer outages or policy changes do not permit that fallback.
BLE cannot take over a radio-channel Batch session. Foreground native operations
are implemented; OS background scheduling is not promised.

## Responsibilities and flow

| Layer | Owns |
| --- | --- |
| Rust | Independent BLE frame codec, lifecycle scope/recovery transitions, durable renewal identity and typed ABI |
| Apple/Android | BLE/HTTP I/O, physical-context refresh, private journal/files, cancellation settlement and receipt ordering |
| React Native | Immutable account/project/device metadata, app-token callback, explicit cancellation and result metadata |
| Firmware | Physical key/source authority, BYO intent, exact encrypted bytes, signature verification and source deletion |
| Customer backend | User authorization/proxy, customer storage/verifier contract and immutable publication |

Native captures scope and connection generation, reserves the SDK device owner,
refreshes physical context, negotiates actual capability, then persists selected
intent before CREATE. Full UUID and generation identify the recording; no short
BLE catalog ID is used. Native retrieves historical authorization via `/prepare`,
requests upload instructions, and opens the exact device owner. BLE reads stream
into a private file, validate the entire SHA-256, then PUT directly to the customer.
Opaque documents, bytes and signed URLs never pass through JS or Dart.

The original manifest persists before completion. Native saves the verification
phase before `/complete`, reconciles status, passes the signed receipt back to the
device for verification and persistence, then confirms its exact digest. Device
source deletion is never authorized by HTTP PUT success alone.

## Recovery and cancellation

- CREATE loss replays the same recording identity after durable native/device
  selection. No new destination is chosen for the selected recording.
- Only explicit `expired` triggers `/recover`. Renewal UUID and expected revision
  commit before I/O; response loss replays that request. Other HTTP 409 conflicts
  retain the source. Upload and cleanup permits retain original signed evidence.
- Lost completion does not cause another PUT. Lost CONFIRM requires saved cleanup
  state, a fresh authenticated device absence proof and the exact server receipt.
- Journals use private permissions, exclusive leases, atomic replacement, file
  and directory fsync and readback. Failed persistence stops dependent actions.
- BLE frames retry identically with bounded attempts. HTTP transient retries
  respect Retry-After; long backoffs return to the host rather than retry early.
- Cancellation/teardown waits for native settlement before releasing ownership.
  Uncertain unsubscribe/abort disconnects the device. Late token/results cannot
  revive a cancelled RN operation. Local source/journal survives cancellation.

## Design review and evidence

Rust workspace: 299 tests, Clippy, generated constants and format checks pass. Android: full SDK source
and actual RN BYO driver compile with explicit API/warnings-as-errors against
Android 36; 22 host/JNI tests exercise the real reducer, framing and production
orchestrator. Apple: complete SDK source builds with Swift 6; RN Swift sources
pass type checking. A real Rust/native executable tests durable storage and
normal/lost-completion/lost-CONFIRM recovery, live HTTP/WS, three reconnects,
uncertain handoff and Stop concurrency. XCTest is unavailable in the local
Command Line Tools; no full Xcode/iOS suite is claimed. RN typecheck, build and
codegen pass with 192 tests; 43 legacy Android upload tests also pass.

`tools/byo/test-native-android.mjs` uses cached pinned dependencies and a built
host JNI library via `BOTA_BYO_JNI_DIRECTORY`; `--compile-sdk` additionally uses
`BOTA_ANDROID_JAR`. `tools/byo/native-apple-smoke.swift` is an executable linked
against the built SDK module and Rust static library. These tests fake physical
BLE and customer HTTP responses; actual signature/journal crypto has separate
firmware/backend tests. No released AAR/XCFramework/app or hardware acceptance
is implied.

Host validation must load the freshly built Rust dynamic library from the JNI
search directory. A stale copy can make new operation codes fail despite current
Kotlin/C sources; refresh that test artifact before interpreting an ABI failure.

## Live entry and recovery

After recording has started, use `uploads.stream(device, null, target)`; native
code discovers the active full UUID/generation through fresh physical admission.
An explicit `ByoRecording` is also accepted. Apple/Android expose the equivalent
`streamByoRecording` with a nullable recording. Stop through the existing recording
control API while awaiting the upload result. Stop is the only concurrent control
exception; provisioning, deletion and other transfers remain exclusive.

The device keeps the complete encrypted source. Native reads 4 KiB BLE ranges,
forms 16 KiB HTTP/WS segments and releases only RAM after customer-durable ACK.
No bytes, signed URLs, manifests or keys cross JS. Customer-qualified modes are
checked before selecting stream intent. Initial WS failure stays HTTP; established
failure gets three reconnects (1/2/4 seconds), then waits for close and fences a
full-file restart. Restart, cancellation or queue overflow use the same pinned
recording/destination and full-file recovery. The private stream journal preserves
selection, reconnect budget, handoff input and exact successor. Device `.BY4`–`.BY6`
provide independent recovery evidence. A lost handoff keeps its original mode;
`assembled` skips another full-file PUT but still reconciles the Batch customer
task, exact manifest and verified receipt. No source is deleted by ACK or PUT.

`sync` discovers a retained stream owner and resumes the fenced transition.
Connection loss still returns to the host for reconnection; it does not invent a
new BLE connection or background scheduler. The supported profile is 128 MiB and
four hours; an incomplete/over-limit source is retained with an error.

Validation uses production native orchestration and the real Rust/JNI/static ABI
with fake customer HTTP and physical BLE boundaries. Live WS/HTTP, three retries,
uncertain handoff, cancellation, unsupported modes, Stop concurrency and receipt
cleanup have host tests. Full Android source/RN-driver compilation and full Apple
SDK/RN Swift checking are separate from mobile packaging and real devices.
Remaining acceptance: AAR/XCFramework/app builds, customer proxy/TLS, physical
BLE/radio/power-loss and consuming apps. The direct requirement/evidence review
is used because compound-engineering is unavailable locally.

## October 11 PR submission checkpoint

Merged main `43f606d` and retained both the external firmware protocol entry and
BYO implementation guidance. Removed the obsolete live-transport source-gap
claim from the earlier plan; native live callers and fenced recovery are present.
No runtime or wire behavior changed during this main reconciliation.

Current checkout verification:

- `cargo test --workspace`: 302 tests pass across 55 result groups.
- `cargo clippy --workspace --all-targets --all-features -- -D warnings`,
  `cargo fmt --all -- --check`, and `cargo xtask protocol generate --check` pass.
- `npm run verify --prefix frameworks/react-native`: 192 tests, typecheck,
  generated-contract validation and license gate pass.
- `node tools/byo/test-native-android.mjs --compile-sdk`: full SDK/RN driver
  initially passed with desktop JSON shadowing Android; corrected below.
- `node tools/byo/test-native-android.mjs`: 22 tests pass using a newly built
  host Rust library/JNI bridge, JDK 17 and the pinned dependency cache.
- Public firmware fixture verifier: five hashes and 13 signed documents pass.
- Apple host build was attempted but is unavailable in this local environment:
  Swift 6.3.3 and the installed macOS SDK built with Swift 6.3.2 do not match.
  Earlier Apple evidence above remains historical, not a pass for this attempt.
  Exact-revision hosted Apple CI must qualify the submission.

PR submission does not publish beta.14 again or activate customer/device gates.
A separately versioned native candidate, rebuilt consumers, live customer
qualification and physical acceptance remain required. The separate marker SDK
PR must retain both feature contracts if it merges before or after this branch.

### Hosted CI compatibility corrections

Initial PR CI found Android's `JSONObject` has no desktop `similar()` method,
which also blocked the Flutter consumer and license dependency build. Replace
that call with a platform-only recursive proof comparator: exact keys and array
order, null/missing distinction, no string/boolean coercion, and decimal number
comparison without lossy Double conversion. A regression covers reordered keys,
nested arrays, mismatched types and adjacent integers above Double precision.
The full-source compile check now excludes desktop JSON from its production
classpath; it reproduced the seven missing-method errors before the fix.
The RN optional hardware revision also respects Android's non-null fallback API.

Swift strict concurrency rejected the live overflow short-circuit autoclosure
capturing actor-isolated JSON. Separate branches preserve short-circuit behavior
without capturing the dictionary in that closure; no unchecked Sendable or
weakened concurrency flag is used. Hosted Apple compilation validates the fix
because the local compiler/SDK mismatch remains.

Requirement review: identity/receipt equality, fallback triggers and cleanup
proof are unchanged. Android platform-only compilation and 23 host/JNI tests
pass after the correction. Exact-revision hosted CI and License Gate must pass
before merge; source tests do not establish hardware or customer acceptance.

### Integration with merged recording markers

Main advanced to `6fddbae` (marker SDK PR #29) during submission. The merge
preserves BYO and protected-streaming status methods, cancels both operation
families on bridge invalidation, and regenerates Rust constants and RN codegen
from the combined source contracts. Marker wire values and completion fences
are unchanged. This supersedes the separate-open-PR note above.

Combined-source checks: 310 Rust tests, Clippy, rustfmt, generated protocol,
202 RN tests/typecheck/codegen/license checks, Android platform-only full SDK
and BYO driver compile, and 96 native upload/marker regression tests pass.
Host BYO tests are rerun against the rebuilt combined Rust library. Apple and
packaged consumer verification remain subject to exact-head hosted CI.

### iOS 15 and Android test compilation follow-up

PR CI on `0722cc4` passed Rust, RN, Web and License Gate, but exposed two
remaining build issues: Swift's `ContinuousClock` requires iOS 16, and two
Android test assertions still used desktop-only `JSONObject.similar()`.
BYO now uses Darwin `CLOCK_MONOTONIC_RAW` nanoseconds (available since iOS 10),
which is monotonic, unaffected by wall-clock changes and advances during sleep.
The existing 30-second refresh and four-hour live budget keep their strict
comparison boundaries; new clock tests cover those boundaries. The public
iOS 15 minimum is unchanged.

The Android assertions now use the platform-compatible proof comparator. The
local full SDK compilation check additionally compiles BYO tests against
Android's JSON API and reproduced both missing-method failures before the fix.
No runtime upload, receipt or deletion semantics change. Local Swift checking
is still blocked by the compiler/SDK version mismatch; hosted iOS device and
simulator builds, strict-concurrency tests and packaged consumers are required
for the exact repaired head before merge.

### Gradle JVM native-library setup

Hosted CI on `79d6f4a` passed both complete Apple lanes, including iOS consumer
builds and the new clock tests. Android compilation also passed, then 17 BYO
integration tests failed because Gradle's JVM had no host Rust/JNI libraries.
All JVM `Test` tasks now depend on `buildHostJni`, use a dedicated host-library
path and track those libraries as test inputs. The helper builds the explicit
Rust host target with the locked dependencies and compiles the real JNI bridge;
Android cross-compiled AAR libraries remain in their separate directory.
No tests are skipped or replaced with mock ABI results.

The same helper builds on the local macOS host and its fresh libraries pass all
23 BYO/JNI tests. Shell syntax and diff checks pass. Local Gradle verification
stops at the missing Android SDK installation; the hosted Linux Gradle unit
suite remains the required check. This setup supports the existing macOS/Linux
POSIX host tests and does not assert Windows host-test support.

## October 12 generated JavaScript migration

The RN source now has a BYO action machine in
`bindings/device-sdk-js/src/byo.rs`. It is Rust source compiled into the ordinary
JavaScript artifact; it reuses the canonical `ByoRecoveryRequest` reducer and
independent BYO BLE framing. `jsHost/byoEffects.ts` executes the returned BLE,
HTTP, WebSocket, scoped journal, file and wait actions through installed OS
ports. It does not invoke the native Apple/Android Bota workflow.

Ciphertext ranges and signed context/authorization/receipt documents are bounded
internal SDK transport values. The public BYO API still exposes recording
metadata and the final recording/session IDs. Signature verification and source
deletion remain on the device; authorization and immutable publication remain
on the backend. No private-key export, signing authority or decryption moves
into JS. This follows the owner's JS-first migration instruction and the
retired RN implementation's internal byte-relay model.

The host supplies a redirect-refusing HTTPS transport and optional WSS port,
private scoped durable persistence, reopenable files with flush/readback and a
captured physical-device reservation. A missing WSS port uses the qualified HTTP
segment route on initial socket admission failure. Socket close must cancel and
join submitted I/O. A timed-out or cancelled receive stays owned until that
receive and one captured OS close settle; failed cleanup poisons the reservation.
Changing the persistence namespace cannot redirect a cancelled operation's late
CREATE save into another account/project scope.

| Requirement | Source evidence and verification | Status |
| --- | --- | --- |
| Rust chooses whole-file/live route, retry, recovery and cleanup | `byo.rs` action machine, canonical core recovery reducer; 15 focused native Rust tests pass | Matched in source |
| Shared framed BLE RPC, exact request ID/operation and bounded notification handling | Canonical `encode_byo_ble`/`decode_byo_ble`, generated request/reply planners; framing and cross-request Rust regressions pass | Matched in source; installed BLE unverified |
| Full UUID/generation catalogue, increasing cursor and bounded entries | Rust catalogue branch deduplicates identities and rejects stalled cursors; focused Rust regression passes | Matched in source |
| Durable device/customer selection before backend CREATE | Returned journal-save action precedes SELECT/CREATE; retained device or journal intent cannot adopt a new destination | Matched in source; host durability unverified |
| Live HTTP segments, initial WS admission fallback, three established WS reconnects then fenced full-file recovery | Rust live branch uses 4 KiB reads and 16 KiB segments; HTTP assembled and 1/2/4-second WS recovery regressions pass | Matched in source; actual customer/WS transport unverified |
| Exact successor and original handoff mode survive uncertain replies | Rust saves the handoff body before POST, checks successor scope/destination/session/owner revision and saves it before device RPC 13 | Matched in source; physical fence unverified |
| PUT/ACK cannot authorize device deletion | Device receipt RPC must return the exact 32-byte digest, followed by durable `ReceiptVerified`/`CleanupPending` transitions before CONFIRM; failed receipt-save regression emits no cleanup | Matched in source; actual signature/receipt trust unverified |
| Cancellation drains submitted mutations and joins resources | Freshly generated JS regressions pass for owner abort, dispatched CREATE drain, namespace changes, socket close/receive settlement and ABORT/subscription release | Matched in source; installed cancellation/durability unverified |
| Stop remains the sole concurrent mutation during live upload | Rust `byoHostPolicy` admits Stop plus its required AuthNonce/state reads only while the captured owner is live; exact allowlist and full adapter suite pass | Matched source gate; installed behavior unverified |
| No integer drift in opaque JSON | Rust rejects nested numbers outside the exact JS range and bounds the captured clock; focused regression passes | Matched in source |
| Reject malformed input and missing durability before acquiring the physical owner | Generated initial rejection is checked before `withDevice`; transfer modes require installed file flush before BLE/backend work, while catalogue remains available | Two generated-JS preflight regressions pass |
| OTA delivery, native OS-port compatibility and physical acceptance | Publication, app delivery, installed-host durability, BLE/radio/power loss and customer TLS remain distinct gates | Unverified |

The 15 Rust checks exercise the production action machine with fake OS/backend
responses. All 14 generated-JS checks in `jsHost/__tests__/byoEffects.test.mjs`
pass against the freshly generated artifact, including execution with
WebAssembly disabled. The standalone Node VM corpus also passes 447 checks,
including the complete BYO batch action trace. These checks do not establish
device cryptography, deployment, hardware or app OTA acceptance; final exact
source differential (91 RPCs/13 commands), optimized Hermes compiler and both
packed generated clients pass. Pinned Hermes VM/hosted native gates and installed
transport acceptance remain separate; see the [migration review](react-native-runtime.md).
