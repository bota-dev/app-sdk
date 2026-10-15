# Retired diagnostic log cleanup

October 15 source follow-up, unpublished. A normal Demo diagnostic subscription
receives device logs, then the owner disables logs and destroys the runtime.
Destruction rejects `scope_changed` from `stopDeviceLogs`. The phone later
reports a disconnected link, which does not establish joined SDK destruction.
No new recording is requested in that attempt.

The actual generated-core adapter reproduces the source defect without hardware.
App retirement aborts its scope before SDK destruction. A concurrent log STOP
can enter the GATT lane after retirement, or successfully finish its submitted
write and then fail the ordinary post-write scope check. Both paths incorrectly
poison cleanup, although the captured monitor removal and disconnect are still
attempted. This reproduction identifies a source defect; it does not attest
every physical callback or device-side log state.

Diagnostic teardown now treats its optional firmware STOP separately from a
normal live control. It checks the captured physical connection and runtime
scope both before entering the GATT lane and immediately before submitting the
write. Retired work sends no new STOP. An already-submitted STOP remains joined
without requiring the old scope to become live again. Its actual port failure,
monitor-removal failure, decoder failure and disconnect failure stay visible;
the executor retains its existing cleanup-failure cache. Captured monitors are
removed and joined even when no STOP can be sent to a retired connection.

Only log-removal promises in `DeviceManager` receive explicit rejection
observation. Every rejected removal remains an error diagnostic, including
cancellation-shaped failures; retirement or an error code alone does not prove
successful release. The generated adapter's failed-cleanup cache still rejects
destruction for genuine release failure. A cancelled unsubscribe command can be
reported separately from a successful global destruction that joins its monitor.
The void unsubscribe callback and manager destruction keep their public types;
non-log subscriptions and native/OS contracts are unchanged.

| Requirement | Evidence | Status |
| --- | --- | --- |
| No stale STOP enters a retired scope or replacement physical connection | Queued-GATT retirement regression and existing replacement-generation fixture | Matched locally |
| Submitted STOP and captured monitor removal remain joined | Actual runtime subscription with held STOP and monitor removal | Red on preceding source, green after correction |
| Genuine release failure cannot become success | Submitted STOP failure, monitor-removal failure including cancellation-shaped codes, and disconnect-failure cases | Matched locally; original errors retained |
| Void log removal cannot produce an unhandled rejection | Actual runtime and real DeviceManager, explicit unsubscribe and logs-enabled destruction | Matched locally; genuine failures remain observable |
| App OS manager release still runs after SDK rejection | Separate app `jsRuntime.ts` lifecycle fixtures | Source correction in both apps; SDK success is not inferred |
| Release and physical qualification remain separate | No core, Rust, Apple pin, firmware or installed-host changes in this correction | Fresh successor qualification and normal diagnostic teardown remain pending |

The six focused cleanup groups and all 522 RN checks pass on the frozen combined
source, including the separate managed-prepare diagnostics. Normal module,
CommonJS and declaration builds, strict TypeScript, Codegen, package metadata,
compiler-free core provenance and the 33-package license gate pass. Two
independent source reviews and focused reruns clear the cleanup boundary.
Rust/generated core and Apple pins remain unchanged. The new Windows checkout's
unchanged core and encrypted-upload vector are restored to their exact HEAD LF
bytes for archive/digest verification; this introduces no tracked source change.

Exact successor CI and complete preserved release files remain required. The
preceding `cc3e301b` main CI Android failure remains unproven; the approved
failure-only JUnit retention change preserves future diagnostics without
weakening or retrying that gate. This correction neither repairs retained
recordings nor establishes cloud commitment, device deletion, app OTA delivery
or firmware acceptance. Public beta.18 remains the published baseline.
