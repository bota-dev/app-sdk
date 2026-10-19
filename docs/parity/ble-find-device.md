# BLE find device

## Current source qualification

Find is present in the newer unpublished source preview
`c4a20f3864dcfcfdffd2372b973473c6a6b54f0e`. Its exact main
[CI 38864800257](https://github.com/bota-dev/app-sdk/actions/runs/38864800257)
passes all nine jobs, with
[License Gate 38864800249](https://github.com/bota-dev/app-sdk/actions/runs/38864800249)
and [CodeQL 38864799326](https://github.com/bota-dev/app-sdk/actions/runs/38864799326).
The source-bound checks pass 533 RN tests, 146 Rust/JS RPCs and 777 pinned Hermes
checks. Canonical generation reproduces the 4,008,620-byte core with SHA256
`d3ad0b30b2792a0b2c9e2b4ae5d6976f457c6448513f27d44fc134d8757877d8`
and input hash
`b6190463d4b13442952f6b35eaa21c43eba2776b184c821a1e5a0b8f989cc8a0`.
The complete 49-file candidate inventory
`5b46ae2f621318354feed4ec4770ed4a91eb5264104566c33070e5e21fde066c`
verifies all five original identities, all 507 RN files and all 59 Flutter files.

Published beta.19 remains immutable source `7a4ff009` and does not contain Find;
see its [publication record](../../release/evidence/2.0.0-beta.19-publication.md).
The newer candidate's SwiftPM/Pod archive hashes (`5ea53fc3`/`b3a283e7`) differ
from the occupied beta.19 pins (`ad00d21e`/`6efc09c0`), which remain unchanged.
A future version/publication decision and physical light/haptic board
qualification remain separate gates. The implementation checkpoint below is
historical; its pending final source-CI gate is now complete.

## Implementation checkpoint

The confirmed requirement is a direct authenticated BLE start/stop action, with
both light and vibration, a bounded local duration and truthful device receipts.
The canonical cross-repository checklist is
[bota find review](https://github.com/bota-dev/bota/blob/feat/find-device-command/docs/reviews/find-device-command.md).

Rust owns the new service codecs, validation and receipt interpretation. The
JavaScript runtime transports those bytes through its existing connection owner,
subscribes before writes and uses a three-second acknowledgement deadline. The
compatibility manager serializes nonce acquisition through command completion;
a subsequent explicit stop acquires fresh authority. No retry replays a start.

The application fetcher must enforce current account/project/binding scope.
The backend signs a single-use, action-specific grant without a cloud queue or
heartbeat requirement. Firmware advertises support only with qualified light and
haptic adapters. Native-only adapters remain unavailable for these additive
methods; there is no silent fallback to recording commands or cloud delivery.

Direct design review: the optional compound-engineering skill is unavailable.
The implementation preserves existing handles and exported recording behavior,
fails closed on old firmware, matches exact request IDs and keeps physical
success distinct from a successful write. Verification: Rust core find tests 3, JS binding tests 69, full RN facade/host
regression tests 533 and RN strict types passed. The committed generated core
comes from Linux CI run 38854313911; compiler-free provenance matches current
Rust source hash b6190463d4b13442952f6b35eaa21c43eba2776b184c821a1e5a0b8f989cc8a0.
Exact final CI rebuild and physical board qualification remain release gates. No package publication or installed-device result is
claimed. The existing public beta.18 cannot execute the new methods.


## October 19 revision 2 source update (unreleased)

Revision 1 above is historical. The current target is Find capability/control/status
version 2 and signed Grant version 4, retaining 193/20-byte sizes and result 0–7.
The active byte contract is `app-sdk/FIRMWARE_PROTOCOL.md`, section "Nearby Find
revision 2". Find challenge/authorization is isolated from recording, Reset, OTA
and upload. A separate backend-signed binding confirmation is durably installed
and device-acknowledged before revision-2 authority is issued. Missing legacy token
commitment requires rebind. Protocol fallback must not bypass current binding checks.

START requires a valid battery sample younger than 60 seconds and more than 20%
power, charging included. STOP bypasses START busy/power admission. Version-2
Status byte 3 reports a precise reason; version 1 retains reserved zero. Original
challenge age is checked both before queueing and at execution; no TTL reset.

The candidate adds backend confirmation/ACK routes, VM slot +11 (separate from
existing provisioning), four appended GATT characteristics, Rust codecs, RN
handshake and app reason display. Publication, actual package adoption, physical
power-loss durability and dual-actuator validation remain separate acceptance.
Existing board hooks still return unsupported. The companion firmware/backend
source now connects the signed direct-cloud controller/ACK path; publication and
physical outputs remain unqualified. See the shared Bota Find review.


### Main integration with BLE naming and protocol reference

Merged main `f6a6dc3`, retaining canonical advertising-name reconnect migration
and the complete firmware reference alongside Find revision 2, trusted binding
and direct-cloud behavior. The generated runtime is rebuilt from combined Rust
inputs, not selected from either side of the merge.

Canonical Linux/Rust 1.98.0 output comes from
[CI 39260313375](https://github.com/bota-dev/app-sdk/actions/runs/39260313375),
source `d19431817fb2fd6b5c4da7321e273f97f233d574`, artifact `12189956858`.
The intermediate check intentionally reports the prior runtime as stale; its
`core.expected.ts` is adopted unchanged. Source fingerprint:
`791496e0b355cdef71b2e65bd8ac5892c3d39b8124d35497b69605d5c0e70543`.
File SHA-256:
`a20182635c1043c9ac2d7dcb3cd7353aa5f5a4078491cf8ea1ae9dd7501edaba`.

Verification: 239 core Rust tests (including 14 connection and 3 Find), 69 JS
binding tests, protocol generation freshness, 5 protocol fixtures/13 signed
documents, full React Native verification under Node 22.23.2 (570 tests, build,
types, Codegen, metadata and 411-package license check), and generated-JS/native
Rust equality on 146 RPCs across 13 commands and the complete BYO batch trace.
Local source provenance matches the Linux output. Successor hosted CI is separate
from this local verification. No package, App adoption or device install occurs.
