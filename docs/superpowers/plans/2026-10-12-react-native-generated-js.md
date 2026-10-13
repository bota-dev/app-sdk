# React Native generated JavaScript migration

Owner request: migrate RN shared behavior into executable JavaScript generated
from Rust, with installed dependencies limited to narrow OS capabilities.
Authority: `internal-docs/App SDK Architecture.md` §§5.5 and 6.3. The existing
TypeScript wrapper over complete Apple/Android workflows does not satisfy this.

October 13 delivery update: beta.16 publishes the generated factory through the
original `@bota.dev/react-native-app-sdk/runtime` entry. Exact-main CI/License,
public RN/Web bytes, the fresh runtime/declaration consumer and all native/Flutter
publication and consumer gates pass. See the
[publication review](../../../release/evidence/2.0.0-beta.16-publication.md).
The checkpoint and provenance below retain their original migration-preparation
snapshot; installed-app OTA and physical acceptance remain separate.

## Acceptance

1. Compile the canonical Rust codecs and workflows into ordinary JS. Verify
   canonical fixture bytes and differential native-Rust/generated-JS execution,
   exact 64-bit integers, bounded memory, malformed inputs and owner fencing.
2. Preserve every supported public device and backend operation. Move receiver
   decisions into shared Rust; JS hosts execute primitive BLE/file/HTTP effects.
   No complete native Bota SDK workflow fallback or handwritten JS wire parser.
3. Preserve cancellation settlement, exact physical identity, durable checkpoint
   acknowledgement, cloud commitment and separate receipt-gated device cleanup.
4. Verify package declarations, frozen compatibility, standalone package loading,
   license checks and Hermes execution. Keep all existing native-platform gates.
5. Commit and push reviewed, verified source to main. npm publication, consuming
   app OTA delivery and physical acceptance are separate gates.

## October 12 source checkpoint

| Requirement | Evidence | Status |
| --- | --- | --- |
| Rust executes as ordinary JS | Private u32 RPC bridge; locked generation; exact `--check`; packed factories load with WebAssembly/native imports rejected | Matched source gate |
| All 13 core commands exposed | Bridge direct-core parity and 91 native/generated RPC comparisons, including complete BYO BATCH trace | Matched source gate |
| Shared receiver and backend policy | Canonical receiver/managed models, 29 receiver regressions; 224 core and 65 bridge tests; strict Clippy | Matched source gate |
| Primitive RN OS ports and public facade | Complete RN verification: 475 tests, frozen compatibility, actual generated workflows; RTC 4, BLE 22 and readiness/lifecycle 9 regressions | Matched source gate; installed ports and hardware unverified |
| Cancellation, ownership and durable evidence | Generated receiver/checkpoint readback, held I/O, cleanup uncertainty, scope/physical generation, provider/queue/constructor teardown tests | Matched source gate; physical durability unverified |
| Native-Rust/generated-JS comparison | `tools/react-native/verify-js-core.mjs`: 91 exact RPCs across all 13 commands | Matched |
| Hermes | Exact generated artifact passes normal `-O`/default-parser bytecode compilation inside a Metro-style module; 447 Node checks match | Compiler matched; pinned VM hosted gate pending; installed iOS/Android unverified |
| Protected data | Owner requested JS-first migration; retired RN already relays encrypted bytes and signed documents internally in JS | Preserve that transport model. Signature trust/decryption stay device/backend owned; private-key generation/export is not added |
| Package and licenses | Both real tarballs include 47 notice files and construct/configure/destroy the generated client without native imports/WebAssembly; companion 4 checks; license gates 410/4 packages | Matched source gate |
| Source delivery | Initial migration pushed directly to main; native/platform jobs and License Gate passed, while exact JS regeneration exposed a cross-host compiler difference | Canonical Linux candidate adopted; final exact-revision CI pending |
| Publication/app OTA/hardware | No new artifact or app release performed | Not implemented by this source delivery |

The retired `react-native-sdk` is a read-only migration input. It uses JS for
protocol/transfer/OTA sequencing and generic BLE/crypto/file host libraries.
Ciphertext and signed documents enter its JS implementation; trust verification
stays on the device/backend. Its legacy private-PEM delivery path is not evidence
for a safe new key boundary.

The earlier clarification question treated the word “opaque” too broadly. The
implementation follows the owner's JS-first migration request and the audited
retired-RN baseline: bounded ciphertext and signed documents may be internal SDK
transport buffers; application-facing operations receive progress and results.
Private-key generation/export, grant signature verification and recording
decryption are not added to JS. The legacy certificate/private-PEM delivery API
is a compatibility input and does not establish the modern non-exportable-key
target. Provisioning still has the released raw-token framing gap; this migration
does not implement the later PK_D-protected binding envelope.

Primitive HTTP transports must refuse redirects before forwarding credentials.
The installed RN XHR fetch polyfill ignores the redirect option, so its global
fetch is not selected implicitly. Supply a conforming generic HTTP transport.
No full Bota native SDK backend is required by that transport contract.

The final generated source provenance is
`0b81ddad0fe950671153010902a96401eb52c83da107630b9b3d52490069e01c`
and the executable TypeScript artifact is 3,956,534 bytes. These checks establish
source behavior and package composition, not a released or installed application.
Full local workspace tooling requires Unix/symlink support unavailable on this
Windows checkout; unchanged hosted jobs remain required. The shared Rust rerun
passed after a transient Windows application-control block, without security changes.

Exact generation is pinned to Rust 1.98.0 on `x86_64-unknown-linux-gnu`.
The first hosted check showed that Windows embeds different path strings and
Cargo includes build-host metadata in target identities. Diagnostic run
`38370392804` captured the canonical Linux candidate from commit `7627add`;
its downloaded archive SHA-256 was checked before adoption. Later generator
changes only tighten compiler/mode preflight; the candidate's provenance header
was updated accordingly. Final Linux CI must rebuild and compare the complete
artifact, then execute it in Hermes. Compiler-free provenance checks on other
hosts continue to support package builds without Cargo.

Normal Hermes optimization initially stalled in control-flow simplification.
The generator now preserves numeric compiled function boundaries through
`Object.freeze`, retaining exact bodies, parameters, hoisting and per-instance
captures. Unsafe reflection/call semantics stop generation. Two transformer
regressions pass, and the complete final artifact passes the unchanged compiler
gate. Same-source Node measurement showed about 0.6 ms added warm startup,
approximately 1% steady-state trace cost and no retained wrapper allocation;
these measurements do not establish installed Hermes/device performance.

Subscription startup packets use shared Rust admission policy: ordinary
command workflows discard pre-subscription snapshots; receipt-only reset resume
preserves the firmware-held replay.
