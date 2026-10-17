# Generated-runtime managed completion handoff

October 17, 2026 — unpublished follow-up to catalog source `1bd3d797`.
Public beta.19 at `7a4ff009` and the private `c4a20f38`, `95635437` and
`1bd3d797` packages remain immutable. Catalog source passes all nine feature
CI jobs and License; its later main run and physical completion are separate.

The normal app's later Sync reports `BOTA_UPLOAD_STATE` with a retained ready
managed journal containing recording/session pointers. Fresh device metadata
shows Idle and an empty catalog. The owner's exact scoped read-only session GET
matches the full capture identity, generation, ciphertext length/hash, published
state and 336-byte completion receipt bytes/hash; the recording GET reports
`uploaded` with matching server plaintext-validation fields. These observations
do not independently verify signatures, explain the deletion cause or prove the
phone's exact error path. Normal app disconnect and SDK destruction join at
06:05:30.355 UTC. The journal is preserved; no Sync replay is authorized by this
source review.

An offline fixture composes the actual generated core, executor and managed IO
backend. A normal generated `ConnectSelected` completion aborts its transport
owner signal. With synthetic HTTP documents and receipt bytes, the fixture
first supplies the managed receipt and confirmation callbacks, then completes
that real core operation. On `1bd3d797`, the signal listener marks the confirmed
slot cancelled, so the later managed `complete` rejects `BOTA_UPLOAD_STATE`
and retains the journal. The still-live-context control passes. This isolates
the terminal-signal mechanism; it is not a full V2 transfer, signature test or
proof of the phone's exact execution.

## Narrow correction

Managed material `confirmed` retains its existing scope/operation checks and
`receiptProvided` precondition. After recording `receiptDelivered`, it detaches
the captured operation-context abort listeners. This is the final material
handoff after the host's validated receipt/CONFIRM path. The subsequent normal
transport retirement must not cancel that ready completion authority.

The executor still aborts every terminal owner signal. Late host callbacks,
resource joins and scope/physical fences retain their existing behavior.
Explicit backend cancellation, runtime disposal and the independent configured
scope signal remain active. The public wrapper still calls managed completion
only after the recording workflow resolves successfully, and cancels failed
attempts. Durable journal removal still requires exact identity, a ready entry
and delivered receipt, with persistence readback and failures preserved.

No Rust policy, cryptographic authority, core generation, native-v1 contract,
public API or retry changes. Existing retained journals are neither imported
nor removed by loading this correction. A restored session in state `created`
has a separate known state-selection gap; this correction does not change it.

## Requirement review

The App SDK architecture's narrow OS/facade boundary and Upload Management's
separate cloud commitment/device cleanup phases remain authoritative. A legacy
`uploaded` status or catalog absence does not substitute for receipt proof.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Preserve confirmed completion across normal owner retirement | Exact old-source fixture has two passes and one intentional failure; the narrow correction passes all three | matched |
| Retain explicit cancellation, scope and disposal refusal | Six permanent groups pass independently, covering pre-confirm owner abort and explicit cancellation, scope abort and disposal after confirmation | matched |
| Retain wrapper success ordering and persistence failure visibility | Actual public wrapper waits for workflow fulfillment and refuses completion after failed joined cleanup; removal/readback failures remain visible and cached without repeated removal | matched |
| Preserve executor/core and receipt policy | Production changes only the final managed listener lifetime; executor and generated core remain unchanged | matched |
| Qualify the local source | All 563 RN checks pass with zero failure, skip or cancellation; strict TypeScript, normal build, Codegen, compiler-free core provenance, metadata and license33 pass | matched |
| Qualify the exact private archive and hosted gates | Required after final source review and commit | unverified |
| Complete normal-app V2 acceptance and recover the existing journal | Requires exact scoped session/receipt evidence and separate owner-run verification; no replay or journal deletion was performed | unverified |
| Restore a session still in state `created` | Separate existing state-selection gap; no source or retry-policy change is made here | unverified |

All six permanent groups also pass independently; the complete local suite
passes 563 checks. The failure and green fixture outputs remain separate.
Fresh physical acceptance, background behavior, signed app/OTA delivery and
publication remain unverified by these source fixtures.
