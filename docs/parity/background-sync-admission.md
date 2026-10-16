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

## October 16 qualified source checkpoint

Exact main `7a4ff0093629c030416f80113c585e10d0177e68` passes all nine
[CI jobs](https://github.com/bota-dev/app-sdk/actions/runs/38829562105),
[License Gate](https://github.com/bota-dev/app-sdk/actions/runs/38829561900)
and CodeQL `38829560828`. Exact logs confirm 526 RN tests, 146 Rust/JS RPCs
and 777 pinned Hermes checks. At 00:48:41.7966910 UTC, all 49 preserved release
files, five original identities, all 500 RN package files, all 59 Flutter source
files and both actual Apple archive checksums verify. The generated core and
version 1 OS contract are unchanged. See the
[complete release evidence](../../release/evidence/2.0.0-beta.19-preflight.md#exact-main-qualification-at-7a4ff009).

The normal One app loads this exact private candidate. Its four due retained
tasks and canonical queue hash remain unchanged after configure and elapsed
retry timing. Following the owner's Bluetooth master toggle, fresh metadata at
00:39:50 verifies the selected Pin, firmware 1.0.18, MTU 512, generation 4,
Idle, pending 0 and LIST 0; SDK destruction joins at 00:40:12. This is bounded
normal-host evidence for false admission, connection and teardown. The host's
own explicit auto-sync trigger remains separate. Demo loads the exact candidate
and returns Idle/pending 1/LIST 1 with its prior unknown journal retained;
controlled recording investigation is ongoing.

The previous local-only and unverified rows above record the source checkpoint,
not the final qualification state. Full recording/media/cloud commitment/device
cleanup, unattended behavior and signed app/OTA delivery remain partial or
unverified. Beta.19 is still unpublished; the original synchronized protected
release is a separate gate, and no firmware installation is implied.
