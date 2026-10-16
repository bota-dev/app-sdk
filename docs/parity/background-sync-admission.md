# React Native automatic upload admission

October 16 source correction, unpublished. Both generated-JS app hosts already
configure `backgroundSyncEnabled: false`. The React Native SDK retained that
existing option but did not pass it to its upload queue. Initializing the queue
immediately scheduled due pending files before public `configure()` resolved;
it also released restored completed files. Calling `pauseUploads()` after
configuration could not prevent the first attempt and would block manual sync.

`BotaClient` now forwards the existing option through `RecordingManager` before
queue initialization. False disables only automatic scheduling and restored-
completed-file release. Queue restoration, validation, sanitization, durable
save, status normalization and all retained identity/timing fields are unchanged.
This is host configuration admission outside the unchanged Rust scheduling and
recovery codecs, with no new retry, receipt or cleanup policy.

Explicit `syncRecording()`, `retryFailedUploads()` and `clearCompletedUploads()`
remain available. Existing `pauseUploads()` still pauses operations, and
`resumeUploads()` only removes that pause; it does not enable automatic work
when configuration is false. There is no live configuration toggle. Omitted or
true configuration retains existing automatic recovery and completed-file release.

The actual public `createBotaClient(...).configure(...)` regression is red on the
preceding source in three of four groups. All four groups now pass: due retry-5
work does not request a provider before configuration or after a 28-hour timer
jump, completed files are retained until explicit cleanup, explicit retained
sync still uploads and confirms, and omitted/true configuration still recovers
and releases automatically. Canonical restore/save remains exercised and the
synthetic retained metadata is unchanged on the disabled automatic path.

The normal module/CommonJS/declaration build, strict types, unchanged Codegen,
package metadata, compiler-free core provenance and 33-package license gate pass.
The full React Native suite passes 526/526. Its first run passed 524/526: the new
optional `RecordingManagerOptions.backgroundSyncEnabled` required one exact
current-facade surface enumeration, and Windows checkout line endings changed
the raw vector digest. The frozen historical API JSON stays unchanged; restoring
the vector's exact committed LF bytes leaves no tracked fixture change. Both
affected fixtures and the complete rerun pass. No assertion or gate is relaxed.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Apply existing false admission before initialization dispatch | Actual public configure with due retained task and timer advance | matched locally |
| Preserve explicit sync and exact confirmation | Real RecordingManager/queue through public client | matched locally |
| Preserve default recovery and completed-file release | Omitted/true and explicit cleanup groups | matched locally |
| Preserve original queue evidence | Restore/save and complete retained task comparison, no no-op optimization | matched locally |
| Normal phone connection and unchanged real queue | Fresh exact successor graph/queue checks required | unverified |

This does not disable a host app's own explicit auto-sync calls after a fresh
device catalog, create a metadata-only test mode, repair media, reconstruct lost
native journals or authorize release. Public beta.18 is unchanged. Fresh exact-
source package/CI and normal-app physical qualification remain separate gates.
