# Generated-runtime pending-catalog admission

October 17, 2026 — unpublished follow-up to `95635437`. The accepted public
beta.19 source `7a4ff009`, qualified private Find source `c4a20f38` and private
ownership/V2-admission package `95635437` remain separate immutable checkpoints.

The normal Demo query preceding Sync fails with
`operation_in_progress` / `ListPendingRecordings` on physical source `95635437`.
The app reports three failed fetches, no successful query update and no Sync
entry. Those observations do not identify the exact competing SDK owner or
independently prove the absence of network admission. Exact journal and scoped
cloud reconciliation remain separate owner-run instruments.

An actual generated-core/adapter fixture holds a public status read and
reproduces the same catalog refusal before any catalog write or managed journal.
Its ordering invariant is red on `95635437`; a settled catalog control case
passes using the actual legacy decoder and exact missing-v2-capability rule.
This is a compatible source reproduction, not attribution of the phone owner.

## Narrow correction

`listPendingRecordings` reserves one entry in the existing bounded ordinary
control FIFO. The queue captures a cloned device, physical generation,
namespace, controls instance and retirement epoch, then rechecks them at its
head. A callback executes the existing catalog body under one direct executor
lease, covering serial verification, legacy listing, optional V2 listing,
shared Rust merge and awaited subscription cleanup. The callback is necessary
because that existing multi-step body is outside `JsDeviceControls` dispatch.

The one-active/32-pending bound, FIFO order and immediate refusal of unrelated
active workflows, BYO owners and uncertain cleanup remain unchanged. Queued
retirement rejects before catalog IO; active retirement joins submitted IO and
monitor release. A caller mutation or A-to-B-to-A replacement cannot retarget
the queued request. Cleanup failure still blocks reuse.

There is no catalog protocol, Rust decoder, merge policy, missing-capability
fallback or retry change. Legacy-only `listRecordings`, transfer preparation,
managed journals, HTTP admission, receipts and recording deletion retain their
existing paths. No public API, generated core or installed native-v1 contract
changes. Successful listing does not authorize a transfer by itself.

## Requirement review

The App SDK architecture's narrow OS/facade boundary and Connection Management's
exclusive ownership remain authoritative; shared Rust retains catalog identity
and protocol policy. Upload Management keeps cloud commitment separate from
device cleanup and protects unknown outcomes.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Order catalog behind an admitted ordinary control | Exact-source held-status regression is red before the correction and green afterward; settled actual legacy decoding still passes | matched |
| Preserve captured target, capacity and retirement fences | Seven actual-adapter tests cover catalog target snapshots, FIFO and queued/active retirement; existing shared-control tests retain the one-active/32-pending bound | matched |
| Retain active workflow/BYO refusal and cleanup failure visibility | The existing 86 affected adapter/V2 tests pass; new catalog tests prove joined monitor cleanup and genuine failure poisoning without adding a parallel workflow policy | matched |
| Preserve shared protocol and durable upload policy | Existing catalog body is unchanged; normal build, strict SDK TypeScript, Codegen, compiler-free core provenance, package metadata, license and diff checks pass locally | matched |
| Complete local qualification | All 557 RN checks pass with zero failure, skip or cancellation; normal build/types, Codegen, compiler-free provenance, metadata and license33 pass | matched |
| Qualify the exact hosted source and private package | Fresh exact-source CI/License and canonical Git-LF archive verification remain required | unverified |
| Complete normal-app V2 upload and receipt-gated cleanup | Requires a fresh exact source/session plus journal/cloud preflight and owner-run physical verification | unverified |

The local reproducer has two passes after the narrow draft, versus one pass and
one intentional ordering failure before it. The final seven catalog tests also
pass independently, and the complete local suite passes all 557 checks, with no
skip or cancellation. Exact hosted/package qualification and the physical result
remain open at this source checkpoint.
This correction neither replays the prior attempt nor repairs retained media,
imports an unknown journal, changes timestamp policy or proves cloud completion,
device deletion, background or OTA acceptance.
