# Managed encrypted-v2 backend adapter

The unpublished [V2 workflow admission correction](v2-workflow-admission.md)
reserves the existing control FIFO and holds one owner through identity/profile
preparation, generated transfer and cleanup. It adds no retry or network replay;
the durable Create boundary and exact physical retry gates remain explicit.

## October 15 managed recording-create identity correction

The shared Rust `ManagedUploadEvent::CreateRecording` plan now supplies
`recording_uuid` and `recording_generation` alongside the exact backend
`device_id`. Previously its create body omitted those fields even though its
session body supplied them. A fresh application namespace could consequently
create another cloud row for a retained physical capture before session setup.
The existing managed input already rejects generation zero and noncanonical
UUIDs; this correction adds no identity inference or validation restriction.

The current Bota API creates idempotently by device/UUID/generation when those
fields are supplied. Its existing HTTP 409 for a previously encrypted-v2 row
remains unchanged. Such a conflict preserves `recording_create_unknown` and
permits neither another create POST for that journal nor session/PUT. This prevents blank-identity
creation; it does not recover an uninstalled application's journals, reconstruct
its cloud pointer or authorize resuming an otherwise unowned V2 session. Legacy
four-byte file IDs must not be expanded into guessed full capture identities.

Backend source review also preserves the first legitimate session: matching
non-null UUID/generation pass `encrypted-upload-v2-session.service.ts` admission,
and `recording.repository.ts` retains them through its guarded `COALESCE` update.
This requires no backend change and is not deployed or physical acceptance.

The Rust regression checks stable capture identity across operation/peripheral
changes and distinguishes different devices, UUIDs and generations. A real
generated-host fixture models the existing backend conflict: it fails against
the preceding generated core because preparation incorrectly succeeds. Shared
Node/native and Hermes conformance checks assert all three identity fields for
root, v1 and dashboard prefixes. The preceding 768-check Hermes result is
historical; the canonical checkpoint below verifies the expanded 777 checks.

The actual Bota One recording-create proxy preserves both fields and forces its
authenticated EndUser after an owned-device read. Its existing 23 tests and
three supplementary actual-handler fixtures pass (exact forwarding, unchanged
409 and foreign-device refusal); this is source verification, not deployed
proxy attestation. The compatibility Android `NativeUpload.kt` and Apple
`UploadOperation.swift` recording-create HTTP bodies are separate handwritten
paths and still omit these fields; this Rust planner change does not claim
their correction. Installed OS ports and native contracts remain unchanged.

At isolated source `11afdedd`, formatting passes and the new generated-host
fixture is red against the preceding committed core. Offline MSVC compilation
stops at unavailable `link.exe`; no downloaded toolchain or execution-policy
bypass is used.

### Canonical execution checkpoint

Exact build-only branch CI `38820667717` passes Linux Rust/tooling, including
`recording_create_preserves_capture_identity_across_transport_and_operation_changes`.
Its stale committed-core comparison intentionally fails and supplies canonical
diagnostics. The retained artifact's transport digest, all 106 exact source
inputs, Linux Rust 1.98.0 and Binaryen 132 provenance verify before adoption.
The generated core is 3,971,776 bytes, SHA-256 `46760f5c…`, with source digest
`7015d6dc…`; the actual fresh-namespace conflict fixture then passes independently.

All 511 local RN tests, normal module/CommonJS/types build, strict TypeScript,
unchanged Codegen contract, package metadata, compiler-free provenance and the
33-package license gate pass. The first full Windows run passes 510/511 because
automatic CRLF checkout changes the unchanged raw JSON vector digest; restoring
that fixture's exact committed LF bytes produces 511/511 with no tracked fixture
or test change. The older 768-check result does not qualify this new core;
nine added identity checks bring the new canonical run below to 777 checks.

Reviewed against Upload Management §1.1: exact create identity and safe conflict
refusal match source/host regressions. Canonical-branch runtime execution passes
below; actual Apple pin reproduction, complete exact-main CI/License/49-file
preservation, publication and physical acceptance remain separate pending gates. Native
compatibility HTTP bodies described above are outside this planner correction.

### Apple checksum and manifest preparation

Canonical branch `37dcf521` passes Rust/tooling, all 511 RN tests and the
JavaScript runtime job in exact CI `38821729337`; its License Gate
`38821851351` passes. Its fresh logs verify the 3,971,776-byte canonical core,
source digest `7015d6dc…`, 146 Rust/JS RPCs across all 13 commands and the complete
BYO batch trace, plus 777 pinned Hermes 0.17 VM/Node checks at 23:17:05 UTC.
These are exact branch runtime gates, not all-nine main qualification.

Source-only `11afdedd` Apple job `116716205790` passes. Its preserved artifact
transport digest and manifest source/version verify, and its native inputs are
identical to the canonical branch. Actual archive SHA-256 values are
`ad00d21ee48249716b5592689df83e6d7f1846ad2cca313ad3976433543393a7`
(Swift) and `6efc09c0d3e835218e086747826ac16cc167264b4649553c8ed23728f10612f5`
(CocoaPods). Existing generators refresh only the two checksum pins. The
Flutter manifest generator refreshes its Apple checksum projection and
root/Flutter source provenance in the same preparation; all 59 Flutter files,
their deterministic archive and other metadata remain unchanged. All 23
Apple-metadata/Flutter-publication tests, generator checks, exact Flutter
candidate verification and checked-template comparison pass.

| Requirement | Evidence | Status / remaining gate |
| --- | --- | --- |
| Stable capture identity reaches creation before session setup | Exact Rust identity fixture; real generated-host existing-V2 conflict case; 511 hosted RN tests | Matched for Rust-generated route; native compatibility HTTP bodies remain separate |
| Ambiguous ownership cannot create/reopen another V2 row | Existing 409 and `recording_create_unknown` preserved; no later HTTP in fixture | Matched bounded regression; lost-journal recovery remains unimplemented |
| Shared semantics remain Rust-sourced and portable | Exact Linux artifact, 106 input hashes, canonical provenance, 146 RPCs/777 Hermes checks and unchanged OS/Codegen contract | Matched canonical branch; exact-main qualification remains required |
| Release archives match their checksums | Preserved exact-source Apple archives and generator-only pins/projection; 23 metadata tests | Prepared; all nine fresh main jobs/License/49 files and actual pin reproduction remain required |
| Publication and real devices have separate acceptance | Private committed-source original RN package; public beta.18 remains baseline | No beta.19 publication, new phone acceptance or device cleanup claimed |

## October 13 generated-JS root proxy admission (beta.17 preparation)

Some authenticated customer proxies expose `/recordings` directly at the HTTPS
origin. The RN facade now normalizes that root to an explicit empty
`apiBasePath`; Rust `ManagedUploadInput` accepts it and produces exact root
recording/session routes. Existing nonempty prefixes remain strict slash-separated
ASCII identifiers, and omission still selects `/v1`. This neither rewrites the
host origin nor introduces a fake prefix or fallback transport. Authorization,
scope identity, durable recovery and signed receipt cleanup remain unchanged.
The compatibility Apple/Android validators admit the same explicit empty prefix;
their existing native route fixtures cover exact root/prefixed paths and reject
malformed prefixes. Those compatibility changes require rebuilt native apps;
the generated-JS factory executes the Rust-generated fix in its JS bundle.

The facade and native Rust regressions first fail against beta.16, then exercise
root/prefixed routing, the omitted-prefix default and malformed path rejection.
Canonical generated-JS, full hosted CI, publication and physical app acceptance
remain preparation gates; see the [beta.17 preflight](../../release/evidence/2.0.0-beta.17-preflight.md).

Published beta.11 adds `createEncryptedUploadV2Backend` to the React Native App
SDK on iOS and Android. It packages the native HTTP/journal implementation
previously supplied by Demo. Package publication and public consumers pass;
physical acceptance remains separate. Beta.10 does not contain this helper. Existing custom native providers
remain supported. The Apple/Android material API gains an optional
`reconcileStaging` callback without changing the wire protocol.

## October 12 Apple session request correction

Published beta.15 removes `end_user_id` from the managed Apple's encrypted-v2
session POST. The strict existing session contract accepts only the ten device,
capture, capability, nonce and ciphertext fields; the extra EndUser field made
Apple preparation fail while Android already sent the accepted body. Ordinary
recording creation still includes the exact EndUser, and native journal/account,
project, device and binding checks are unchanged. The backend derives session
ownership from the authorized recording and authenticated route.

The native request regression checks the complete session key set and separately
retains the EndUser on recording creation. It failed against the previous Apple
body, then all 21 native upload suites passed after the one-field removal under
Swift 6 with warnings as errors. This proves emitted request parity. Exact
beta.15 CI, protected publication and public package verification passed; see
[publication evidence](../../release/evidence/2.0.0-beta.15-publication.md).
Rebuilt consuming apps and a fresh managed Bota One physical upload remain
separate acceptance gates.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Emit the existing strict encrypted-v2 session body | Red/green native request regression verifies exactly ten keys | matched |
| Preserve account/EndUser authorization and recording ownership | Recording-create EndUser assertion remains; no scope/auth/journal code changed | matched in controlled tests; physical acceptance separate |
| Preserve normal upload/recovery fences | Complete 21-suite native backend regression runner passes | matched in controlled tests |

## Customer integration

```ts
import { createEncryptedUploadV2Backend } from '@bota.dev/react-native-app-sdk';

const lifetime = new AbortController();
const uploads = createEncryptedUploadV2Backend({
  baseUrl: 'https://your-backend.example/v1',
  scopeKey: `${environment}/${accountId}/${projectId}/${endUserId}`,
  accountId, projectId, endUserId, environment,
  signal: lifetime.signal,
  getAccessToken: async signal => getCurrentAppAccessToken(signal),
});

// Use a freshly connected, authorized device and its v2 catalog entry.
// Invoke this same operation after reopening/reconnecting to resume its journal.
const { recordingId } = await uploads.sync(device, recording, {
  deviceId, bindingGeneration,
  onProgress: progress => showProgress(progress),
});

// On logout, project/account/device-binding changes, or host teardown:
lifetime.abort();
await uploads.dispose();
```

This removes custom native HTTP, status-polling and journal code from customers.
The host still supplies fresh app credentials, stable identity, scope
invalidation and the reconnect/sync trigger. Construct a new helper for a new
scope; an A → B → A account transition never revives an aborted helper. The
existing legacy `complete`/`uploadRecoveryProvider` callbacks do not select v2.
A package upgrade alone does not migrate an application using the legacy path.
A new native app binary is required for the added TurboModule. When migrating
an existing custom journal, pass its exact per-recording `priorUpload` pointer
to `sync`; the helper cannot infer identities stored by arbitrary host code.
Keep unresolved old work until reconciled instead of treating it as a new upload.

The HTTPS base URL is the route prefix of the customer's authenticated proxy.
It must expose the existing Bota encrypted-v2 recording creation, session
create/status/recover/staging-url/manifest and device context create/status/proof
routes, preserving response bodies and status codes. The backend authorizes
the exact tenant, EndUser, device and binding; the app supplies an application
access token, never a Bota secret API key. The optional `organizationId` supports
the first-party dashboard bridge, whose base path is
`/dashboard/projects/{projectId}`. No Bota API schema changes are required.
An integration exposing only legacy upload-complete must add the v2 proxy routes.

## Recovery and completion

Native journals bind the backend origin/prefix, account/project/EndUser,
environment, device/binding and exact recording UUID/generation/length/hash.
The journal stores metadata and cloud identity, not credentials or signed
documents. Reopening and syncing the same recording reuses that identity and
queries the session. An ambiguous initial recording/session creation is parked
instead of issuing a potentially duplicate POST; automatic reconciliation of
that initial unknown outcome is not implemented in this adapter. The first-party
dashboard has a scoped lookup endpoint, but it is not a public API-key route.

Before any new ciphertext PUT, the SDK tries the exact manifest, then validates
the retained local file after the provider callback. An accepted manifest skips PUT. Only HTTP 409 with
`encrypted_upload_v2_staging_missing` permits PUT. Generic conflict, permissions,
transport failure and server failure do not prove the object absent. Already
staged/ready/processing/published sessions also skip PUT.

After manifest acceptance, native code polls session status every two seconds
for at most 60 polls. Each retry-safe request can make up to three attempts
with a 250 ms delay for transport/429/5xx failures. HTTP latency adds to the
polling window. Exhaustion retains recovery state and source audio; the host's
next sync/reconnect resumes. There is no OS background wakeup guarantee.
The firmware owns direct WiFi/4G retries independently.

V2 manifest acceptance is `202`; verification remains asynchronous. Recording
`pending` and session `ready`/`processing` are not deletion permission.
Publication sets recording `uploaded` and supplies the exact signed receipt.
Native SDK/firmware validate the receipt before CONFIRM/deletion; the backend
journal is removed only after native sync confirms success. App closure can
interrupt cleanup while cloud verification continues.

After successful native cleanup, the helper does not issue a redundant cancel
that could turn confirmed success into a spurious retry after bridge teardown.

## Design and acceptance review

Reviewed against Upload Management §1.1 and Encrypted Upload v2. Exact main
CI `37078793682` and License Gate `37078793554` pass at `344cd2e`; see the
[publication record](../../release/evidence/2.0.0-beta.11-publication.md).

| Requirement | Evidence | Status / remaining check |
| --- | --- | --- |
| Small customer integration; app authentication stays scoped | Exported helper, native credential broker, nine JS integration cases | 158 RN tests and linked iOS/Android consumers pass |
| Reuse exact recording/session after interruption | Ported native journals and restart/nonce recovery suites | 43 Android recovery tests and 16 Apple suites pass; initial ambiguous create remains parked |
| Lost PUT response does not cause another upload | Native manifest replay tests and registry manifest/lease validation tests | Native host/registry CI passes; physical interruption checks remain unverified |
| Account changes reject late work | Captured scope, AbortSignal, fresh credential requests, cancel/dispose tests | JS/native cancellation suites pass |
| Cloud commitment and device cleanup are distinct | Native receipt validation/CONFIRM unchanged; journal completion delayed | Host suites pass; device power-loss qualification not run |
| Historical native compatibility path keeps opaque artifacts and audio outside JS | Metadata projection and native material registry | Codegen/type checks and linked packaged consumers pass; generated-JS ciphertext handling has its separate runtime boundary |
| Existing custom integrations remain valid | Optional native callback defaults to old decision provider | Existing suite and native CI pass |

The first CI pass caught a file-check ordering regression: provider callbacks
can change the file, so validation must remain after the callback, including
when it skips PUT. The original tampering regression is retained unchanged.
The corrected source passes it in exact candidate and main CI.

The change does not claim cross-channel deduplication, a new async API, physical
parity, streaming-v2, or release-gate enablement. The standalone Apple/Android
facades keep their custom-provider integration; this packaged HTTP convenience
entry point is currently React Native only.
## October 15 managed-prepare diagnostic preservation

The managed backend now retains an allowlisted, neutral diagnostic from its own
prepare call when the public client subsequently rejects that profile as
`application_material_rejected`. Only known managed-upload codes or an exact
canonical HTTP status marker are retained, with the fixed operation
`PrepareEncryptedUploadV2`. Provider messages, bodies, details, causes, tokens
and signed material are excluded. An existing material rejection alone still
does not establish an HTTP status or backend cause.

The diagnostic belongs to one sync invocation and its latest profile request.
An older provider completion cannot overwrite a later request. Substitution
requires an exact structured material rejection at a known encrypted-upload
operation; unrelated cancellation, protocol and cleanup failures remain intact.
The wrapper joins its existing coalesced cancellation before substitution and
rechecks external scope, caller and disposal state. No retry, journal, receipt,
CONFIRM, identity or authorization rule changes.

Seven composed host groups pass with the real public recording client and
managed wrapper. They cover recognized/redacted errors, malformed/unknown and
foreign-operation refusal, separate invocations, out-of-order profile requests,
scope/caller cancellation during joined cleanup, and cleanup-failure precedence.
The generated-core HTTP409 case makes one exact identity-bearing create POST,
preserves `recording_create_unknown`, and performs no session create or PUT.
The preceding implementation loses the useful diagnostic in the red fixtures.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Preserve bounded managed failure without exporting provider material | Real client/provider composed fixtures and canonical HTTP conflict | matched locally |
| Diagnostic cannot cross invocation/request ownership | Separate-invocation and reordered profile-request fixtures | matched locally |
| Keep cancellation, cleanup and commitment policy | Joined cancel, external abort and cleanup failure cases; existing confirmation gates unchanged | matched locally |
| Explain the earlier phone's actual HTTP failure | Historical terminal code was already discarded | unverified; no inferred HTTP409 |
| Published package and fresh normal-app success | Final exact-source qualification and phone run remain separate | open |

This is a TypeScript host diagnostic correction. Rust/generated core and native
contracts are unchanged. Local fixtures do not recover an uninstalled native
journal or establish cloud commitment, device cleanup or physical acceptance.

The frozen combined successor passes all 522 RN checks, normal module/CommonJS/
declaration builds, strict types, Codegen, compiler-free core provenance, package
metadata and the 33-package license gate. Exact main CI, preserved archives,
publication and fresh normal-app acceptance remain separate gates.
