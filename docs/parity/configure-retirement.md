# Retired configure cancellation diagnostics

October 15 follow-up. Normal round 6 confirms bounded Demo and One connection,
settings, heartbeat, disconnect/reconnect and joined final destruction with the
packed Rust-generated runtime. Both apps complete two normal connections and
settings writes; the retained four queue snapshots remain unchanged. One also
shows an SDK-internal `cancelled` LogBox before successful connection; the exact
phone configure owner was not traced. A separate actual-runtime fixture
reproduces an explicit scope abort and admitted destruction while a pending BLE
state read rejects `cancelled`; the SDK logs that expected retirement as ERROR.
App-level stale-owner handling already fences its own diagnostics.
This observation does not qualify recording/media/upload or complete release.

`BotaClient` now gives each admitted configure attempt a private marker. A
newly admitted outer `destroy()` marks only the then-current attempt; coalesced
destruction cannot mark a later configure queued after it. The failure handler
captures that marker before awaiting its own cleanup. Only exact error code
`cancelled`, already-requested destruction of that attempt, and successful
cleanup change the diagnostic to debug. Configure still rejects with its
original error and emits the existing error event. Current cancellations,
other failures and cleanup failures retain ERROR. This changes no cleanup or
state policy, public API, Rust/generated core, native/OS-v1 contract or Apple
artifact bytes.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Retirement evidence belongs to the exact configure admission | Private closure marker and guarded configure-finally cleanup; queued-next-attempt regression | Matched locally and independent source review |
| Expected retired cancellation does not produce false ERROR/LogBox | Actual runtime + BLE PLX port pending state read, scope abort and joined destruction | Red against preceding source, green after correction; normal round 7 pending |
| Genuine failure and cleanup uncertainty stay visible | Current cancellation, non-cancel racing destroy, failed cleanup and destroy-during-cleanup cases | All preservation fixtures pass; existing error event and rejection retained |
| Shared source/native compatibility remains explicit | Rust/generated core and Apple checksum pins unchanged; compiler-free source provenance | Source hash 4f24ed3b… verifies; no native rebuild introduced |
| Complete release and physical acceptance stay separate | Six focused regressions, 510 full RN tests, normal build and independent review pass | Fresh exact-main CI/License/archive qualification and round 7 pending; beta.19 unpublished |

The six focused cases pass independently. Two expectations fail before the
correction, while all four genuine-failure preservation cases already pass.
All 510 full RN tests, normal module/CommonJS/types build, post-build client
compatibility tests, strict TypeScript, Codegen, package metadata, the 33-package
license gate and unchanged generated-core provenance pass. The previous canonical source/Apple preparation and bounded
round 6 evidence remain in [connection-attempt retirement](connection-attempt-retirement.md).
No firmware, model identity or retained recording bytes are changed.
