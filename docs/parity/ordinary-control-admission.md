# Ordinary generated-runtime control admission

October 15 source correction. Normal One and Demo startup settings writes can
fail with `operation_in_progress` before model encoding or GATT submission.
The adapter claims an exclusive executor lease before reaching the controls'
ordered IO lane. DeviceManager starts its status watchdog asynchronously;
initial status reads, subscription setup and settings writes can overlap.
An actual generated-runtime/DeviceManager regression holds watchdog monitor
setup and reproduces both initial control failures against `d13b3aa5`.
The exact competing owner in the earlier phone observations was not traced.

The existing ordinary public controls now enter a FIFO before claiming their
individual leases. One active control and at most 32 pending controls are
accepted. Arguments are copied at submission; each call retains the exact
controls instance, serial/peripheral identity, physical generation, runtime
epoch and namespace. Admission and execution both check scope and executor
ownership. Only the exact active ordinary control may have a successor queued;
workflows, connection adoption, catalogs, firmware and BYO owners still refuse
unrelated controls at submission. Shared Rust BYO borrowing policy is unchanged.
This adds no retries, priorities or workflow queue.

Disconnect, destroy, scope abort and exact physical-generation loss reject
pending writes and observer STOP calls immediately. Teardown still joins any
submitted active IO, including a host port that ignores cancellation. Replacement
connections cannot replay those pending calls. Uncertain cleanup blocks further
execution. Queue admission may await settlement of its exact non-cancelling
ordinary owner, but execution must recheck ownership and cleanup before claim.
A controlled public executor `direct`/`borrowDirect` test covers that settlement
boundary; it does not establish a reachable normal-control cleanup window or
the cause of the earlier phone failure.

This is TypeScript OS-admission mechanics. Rust policies, generated executable
core, installed version-1 OS/native contracts and device wire formats are
unchanged. Compiler-free provenance verifies source hash
`4763600c447609b1cd4554adb264c00a5a30bdda45a06c58fa6ffa98db441a39`.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Ordinary startup controls order before exclusive claim | Actual DeviceManager/watchdog regression fails against d13 and passes with FIFO; adapter read/settings/subscription ordering regression | Matched in source and focused checks; fresh normal phone retest pending |
| Exclusive workflows and shared policy remain authoritative | Immediate workflow/adoption refusal tests, unchanged BYO branch and preclaim executor guard | Matched locally; fresh exact-main checks pending |
| Pending mutations preserve original intent and physical identity | Mutable argument, 32-pending limit and same-peripheral replacement regressions | Matched locally; no stale mutation submitted |
| Teardown joins active IO without replaying queued writes or STOP | Disconnect/destroy/logout ignored-abort fixtures, physical disconnect and uncertain-cleanup fixtures | Matched locally; broader OS/background behavior unverified |
| Cleanup cannot authorize replacement work prematurely | Controlled executor settlement test accepts admission only, keeps claim exclusive and preserves failure refusal | Matched boundary coverage; no physical finish-window cause claimed |
| OTA-compatible shared source architecture | No Rust/generated/native/OS-v1 changes; strict declarations, provenance and normal RN build pass | Matched locally; publication and app delivery remain separate |

Nine focused regression groups and all 502 full RN tests pass, including the
settlement-boundary regression. Strict TypeScript, normal module/CommonJS/types
build, package metadata, unchanged native Codegen and the 33-package license
gate also pass. Exact-main CI/License, preserved
release archive qualification and normal phone round 5 remain separate gates.
Public beta.18 remains the published baseline; beta.19 remains unpublished.
