# Generated-runtime encrypted V2 workflow admission

October 17, 2026 — unpublished source follow-up to current-connection ownership
`e4a526ee`. Public beta.19 at `7a4ff009` and the qualified private Find package
at `c4a20f38` remain unchanged.

A normal Demo V2 sync on the selected Note returns `operation_in_progress` after
the app selects its explicit encrypted V2 route. Its redacted error does not
identify the active SDK operation. An actual c4 runtime/managed-facade fixture
reproduces a compatible boundary: holding a public status read makes sync refuse
at `VerifyEncryptedTransferIdentity`, with no managed journal or HTTP call.
Settled public status and firmware-log subscriptions do not themselves block
preparation. These source results do not identify which owner caused the phone
failure.

## Correction

Only explicit generated-runtime V2 sync joins the existing bounded public-control
FIFO. Previously admitted ordinary controls retain their order, the V2 intent
occupies one slot, and later admitted ordinary controls cannot overtake it. The
existing limit remains one active operation and at most 32 pending entries.
An active workflow, BYO owner or uncertain cleanup still refuses admission;
another V2 workflow is not silently queued behind an existing V2 reservation.

The queued intent captures its device/recording arguments, physical connection
generation, persistence namespace, control instance and retirement epoch. It
rechecks ownership at the head before any identity/profile/journal side effect.
Permanent scope retirement and physical replacement cannot revive an older
intent, including A-to-B-to-A transitions.

Once admitted, one executor workflow lease spans identity verification,
capability/checkpoint reads, managed profile preparation, the generated Rust
transfer and joined cleanup. The executor can prepare a command under that same
owner before starting Rust. Its preparation promise is tracked; cancellation
before Rust starts still waits for the submitted preparation and cleanup, then
rechecks cancellation/current context before accepting the command. Existing
bare-command execution retains its path.

Exact queued cancellation removes and rejects its slot before execution. Active
cancellation/destruction joins submitted work, including an already dispatched
Create response and its durable journal drain. Cleanup is cached and remains
under the owner until joined; genuine cleanup failure still prevents reuse.
No executor claim is nested inside that prepared callback, and the callback
does not await its own cancellation settlement.

This is OS/facade admission coordination. Rust command planning, ciphertext and
receipt validation, HTTP retry policy, stable capture identity, installed native
version 1 ports and all existing journals/files remain unchanged. It adds no
automatic retry, network replay, legacy fallback or new public SDK signature.

## Durable Create boundary and retry limits

The preceding c4 source has three exclusive claims: identity verification,
managed preparation and generated transfer. The last can refuse after managed
network admission. Therefore a busy code alone never proves no Create occurred.

Managed preparation saves and reloads `recording_create_unknown` before invoking
Create HTTP. The app's native persistence source atomically replaces, fsyncs and
reads back that JSON file. Cancellation/release preserve it. The only managed
journal removals are an exact no-entry Create authorization rollback on HTTP
401/403, or successful receipt-gated completion. Under these source/port
contracts, a successful create followed by a transfer-claim failure retains its
journal. A bounded exact-file absence is not independent HTTP or cloud proof.

The owner separately reconciles the physical attempt through the existing scoped
app API: the complete recording-page read finds no exact capture match. The
retained Note catalog row and old Pin journal stay preserved. A physical retry
still requires a qualified new source/session and fresh exact journal/cloud
reads; this correction neither performs nor authorizes a replay by itself.

## Requirement review

Basis: `internal-docs/device/Connection-Management.md` requires exclusive adapter
ownership and serial-strict reconnect; `internal-docs/device/Upload-Management.md`
and `internal-docs/App SDK Architecture.md` retain stable identity, durable App
recovery and receipt-gated cleanup. Their shared Rust policies are unchanged.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Ordinary reads cannot cause an immediate pre-journal V2 busy failure | Real runtime/managed facade held-status fixture is red before the correction and waits correctly after it | matched |
| Preserve FIFO and active-workflow refusal | Composed fixture orders prior read, V2 HTTP and later read; profile-stage controls/connection/second V2 refuse without more HTTP | matched |
| Fence queued cancellation and retired owners before side effects | Actual fixtures cover caller abort, destruction, permanent scope retirement and scope/physical A-to-B-to-A, with no managed journal/HTTP | matched |
| Join active preparation before release | HTTP-held caller-abort/destruction fixtures wait for its late response, preserve the unknown journal and start no media IO | matched |
| Use one owner through the first generated transfer effect | Public provider/nonce/sink fixture holds the actual generated LoadCheckpoint effect; preparation, effect and cleanup share one operation/generation; cancellation joins before ordinary reuse | matched |
| Preserve existing executor/adapter/managed diagnostic behavior | All 81 affected existing host checks pass locally; strict SDK TypeScript passes | matched |
| Preserve the broader SDK contract | All 550 local RN checks, normal module/CommonJS/declaration build, strict TypeScript, Codegen, compiler-free core provenance, package metadata and the 33-package license check pass | matched |
| Fresh hosted/archive qualification and physical retry | Required for this new exact source; source reproduction is separate from phone-cause proof | unverified |

The ten new actual-runtime groups pass independently under both the source
author's full run and peer review. The full local run has 550 passes, zero
failures, cancellations or skips. Shared core input hash remains
`b6190463d4b13442952f6b35eaa21c43eba2776b184c821a1e5a0b8f989cc8a0`;
this TypeScript boundary correction requires no generated-core or native change.
Windows uses the existing cached toolchain and serial local test invocation;
hosted CI retains its normal commands. Fresh feature CI/License, main integration,
package readback and normal-app physical retry remain separate gates.

Unknown recording time/duration metadata, cloud commitment, signed receipt,
device deletion and complete normal-app/OTA acceptance remain separate. The
source fix does not repair retained audio, migrate lost journals or establish
those gates.
