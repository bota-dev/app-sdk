# React Native Upload Recovery

Source implementation for maintenance recovery behavior at reference revision
`318974f925a573cf04b0d624978bee04784af09b`, including `4702e6d` and `2932b0e`.
This is source/test evidence, not publication, physical-device, or mobile
process-kill qualification. Encrypted-upload-v2 BLE recovery is a separate
native workflow; this document describes the compatibility batch upload queue.

## Public Contract

- `BotaClient.configure({ uploadRecoveryProvider })` and
  `new RecordingManager({ uploadRecoveryProvider })` restore fully received,
  native-owned recording files. There is one live journal owner per
  compatibility client. A second manager fails initialization before reading
  or scheduling the journal. Destroy starts cancellation once; replacement
  initialization waits for previous writes and the native stop promise.
- `UploadRecoveryContext` carries task, backend recording, device, device
  recording UUID, non-secret `recoveryScope`, actual native file size when
  known, relay route, content type, optional device SHA-256, optional
  `completionPending` phase, and an attempt
  `AbortSignal`. Providers must return credentials for the exact original
  recording ID and scope, and must not change the persisted upload route.
  Scope should identify account, project, and environment, never credentials.
  The helper accepts backend `file_size_bytes` as a nonnegative safe integer
  or canonical unsigned-decimal string; null/absent evidence remains optional.
  It normalizes strings before comparing bytes and rejects malformed, unsafe or
  mismatched evidence without PUT or cleanup, so hosts need no numeric decoder.
- `UploadInfo` adds `recoveryScope`, `alreadyUploaded`, `reuploadRequired`, `complete`, `signal`,
  and `dispose`. `complete` resolves only after durable backend acknowledgement.
  Its context contains native file length, optional integrity hash, and the
  attempt signal. The signal must be honored by the host when its account or
  authorization context changes. `dispose` releases listeners/leases on
  success, failure, cancellation, and late provider resolution.
- `UPLOAD_RECOVERY_VERSION = 1` identifies the recovery API additions, **not**
  support for the legacy JavaScript recording-byte store. The exported
  `RecordingDataStore` shape is migration compatibility only. Supplying this
  option throws explicitly in both configuration entry points before native
  configuration. Its callbacks are never invoked or silently ignored.
- Existing Demo/Bota One configurations that use the version marker to supply
  `RecordingDataStore` **cannot migrate unchanged**. They must remove the byte
  store, use native ownership, provide scoped recovery credentials and durable
  completion, and pass application acceptance gates. No applications are
  upgraded by this change.

## Persistence And Completion

Audio never crosses JavaScript. Default native files remain in Apple's
application-support `BotaDeviceSDK/Recordings` directory and Android's
`noBackupFilesDir/bota-app-sdk/recordings` directory. Explicit native storage
configuration changes the recording root. Release accepts only UUID-named
`.recording` regular files immediately within that configured root, not
symlinks, directories, or arbitrary paths from a journal.

The journal contains only IDs, native local path, size, scope, route and
`completionPending` flags,
content type/hash, status, retry count/backoff, and timestamps. URLs, upload
tokens, bearer authorization, functions, signals, callback objects, unknown
properties, and arbitrary error text are excluded by whitelisting. In-memory
credentials are separate from task snapshots. Errors persisted by the queue
are not serialized. Host-supplied identity fields must themselves be non-secret.

Native load performs no mutation or cleanup. The entire journal is validated
before JS normalizes interrupted `uploading` tasks to `pending`, persists the
sanitized state, or releases completed files. Malformed JSON, malformed rows,
duplicate IDs, invalid dates, negative counters, and mistyped metadata fail
without overwriting the original journal. Native saves independently validate
the metadata, sync the file, atomically replace the journal, and fsync its
containing directory. An uncertain write blocks release until a successful
save establishes durability again.

Normal order is native PUT/relay, durable host completion, completed journal
save, native release, then foreground BLE confirmation. Native upload itself
never unlinks the file. Release verifies exact task ID, path, and completed
journal status, then unlinks and fsyncs the owned recordings directory before
returning success. An already-missing owned file still requires that directory
barrier: it may be a retry after an earlier unlink whose sync failed. Failed
unlink or directory sync keeps the completed entry for later cleanup, even if
the local file is already absent. Release never deletes backend data. Clearing
completed tasks removes only the durably released snapshot, preserving entries
after barrier failures and entries completed concurrently.

`alreadyUploaded` skips PUT/relay but **still requires `complete` to resolve**
before the journal can complete or files can be released. Unlike the reference
shortcut, the flag alone is not acknowledgement. A URL/token completion-only
request is not synthesized for this branch; the host supplies `complete`.
For an ordinary upload, native completion URL/token or a successful relay ACK
remain supported. A JS `complete` callback takes precedence over native
completion URL/token. Legacy nonrecoverable callers without a completion
callback retain the historical custom-completion behavior; they must not infer
durable backend completion from that legacy mode.

Actual transfer-result file length feeds callbacks and retained-file length
checks. List estimates are never substituted for encrypted file length or a
host completion callback. Missing native size fails closed for that callback;
an older plaintext/no-callback compatibility path may retain its list estimate.

## Retry And Lifecycle

- `createUploadRecoveryProvider` retries only an error with numeric `status: 425`
  and exact `data.error.code: 'upload_verification_pending'`. The host preserves
  that stable error classification while retaining responsibility for HTTP
  authorization, request timeout and abort handling. Other statuses, codes or
  message strings do not qualify. Completion polls reuse the original recording
  and identical evidence with 1–2 second jitter for up to two minutes (at most
  120 attempts); cancellation and scope checks fence every request and ACK.
  The polling budget does not replace a host HTTP request timeout.
- Before invoking host completion after a successful byte upload, the queue
  durably writes `completionPending: true`. Restart or fresh foreground
  credentials preserve that phase even while the cloud record is still
  `pending`: the provider reconciles the same record and retries completion
  without requesting an upload URL or sending bytes. The phase is **not**
  verification or permission to delete. Only an authenticated backend
  `integrity_failure` makes the helper return `reuploadRequired: true`, which
  durably clears the phase before an explicit repair upload. Custom providers
  must restrict that flag to the same authoritative repair decision.
- Exhausting the verification polling budget retains the native/device copies,
  parks completion for 30 seconds, and preserves the upload-repair retry count.
  The live queue can then retry completion; a restarted app honors the persisted
  next-attempt time. No background OS wakeup is installed. Backend ACK still
  precedes the durable completed journal, native release and foreground device
  confirmation. Both native journal adapters must be rebuilt to retain the new
  optional phase; this behavior cannot be delivered by a JS-only update to an
  older native binary.
- Startup automatically schedules eligible retained pending files only when
  a recovery provider is configured. Without it, old credentials are discarded
  and tasks wait for scoped foreground sync with fresh credentials.
- Providers are called again after failed attempts. Expired initial credentials
  and deferred credentials with an empty destination URL are disposed and
  refreshed through the provider before sending bytes. The provider receives
  the native file length and detected route after transfer; a foreground retry
  uses the retained task's route before validating the refreshed credentials.
  A nonempty destination still cannot change the original route. A null
  result parks the task for 30 seconds without consuming its retry budget.
- Up to two background uploads run concurrently. Failures use persisted delays
  of 30 seconds, 2 minutes, 10 minutes, 1 hour, then 4 hours, with six retries
  and a 24-hour automatic retry window. Pause prevents new scheduling, not
  cancellation of already active operations. Resume honors persisted backoff;
  explicit retry resets failed/deferred task budgets and backoff.
- Every native upload attempt has a new ID. Late progress, canceled providers,
  late host ACKs, and old-owner callbacks cannot complete or confirm a new
  attempt. Reentrant destroy, cancel, or host abort from `uploadStarted` is
  checked before native upload begins. Native cancellation keeps operation
  ownership until that operation settles and rejects a late start using an
  already canceled attempt ID.
- Background recovery does not send BLE confirmation through a stale saved
  connection. A later foreground sync reuses an exact matching completed or
  retained task and confirms through the caller's current device connection.

## Limits

- A process loss between successful PUT and the phase journal write can still
  require backend reconciliation without that local evidence. This change does
  not make S3 and the local journal atomic or prove exactly one PUT in that gap.
  Backend status/evidence checks and idempotent completion remain necessary.
- This queue does not resume partially received BLE files. A crash before the
  completed-file metadata commit requires another device transfer; the device
  copy has not been confirmed or deleted.
- Explicit queue cancellation/clear removes queue entries but preserves
  unacknowledged native and device copies. Orphan-file garbage collection and
  recovery of preexisting legacy JS byte-store files are not implemented.
  Transfer cancellation fences later upload/confirmation, but this facade has
  no per-transfer BLE cancellation method; destroy stops native recording work.
- Retry timers require a live JS runtime. This change does not install iOS
  background URL sessions, Android WorkManager, or OS process wakeups.
- File size detects truncation, not same-length mutation. Existing native
  transfer integrity and host checksum validation remain authoritative.
- No hardware, kill/relaunch-on-device, or end-to-end customer backend tests
  were performed. Native filesystem/HTTP tests use temporary owned files and
  controlled HTTP responses; JS tests inject the native boundary, not audio.

## Test Evidence

### October 8 pending completion recovery (unpublished source)

The first exact pending 425 previously escaped the helper, consuming an upload
retry and allowing a later still-pending record to receive another PUT. The
helper now owns bounded completion polling; the queue and native journal retain
the byte-upload phase separately from backend commitment. Legacy compatibility
uploads are the scope. Encrypted-upload-v2 signed receipts and transfer recovery
are unchanged.

| Requirement | Evidence | Conformance |
| --- | --- | --- |
| Retry exact verification-pending responses with the same identity/evidence | Host tests reject seven wrong classifications, repeat the same completion payload, and bound the polling budget | matched at the host callback boundary |
| Exit/restart while verification remains pending without a second PUT | Queue tests persist the phase before completion, restart after budget exhaustion or a lost response, and reject fresh foreground byte resend | matched with injected native storage; physical acceptance pending |
| Verification waiting does not consume repair attempts | Exhausted polling at retry count five parks with that count unchanged | matched at the queue boundary |
| Explicit integrity repair remains possible | An authenticated integrity-failure record clears the durable phase before one repair PUT | matched at the queue boundary |
| No cleanup before ACK or after account/cancellation changes | Pending, late-ACK, native journal release and scope regressions | source tests; native execution recorded separately |
| Durable phase survives platform persistence | Android/Apple journal regressions retain the boolean, reject mistyped values and reject release while pending | Android focused JVM regression passed with an injected directory barrier; Apple execution and full native durability remain hosted gates |
| Wider architecture and device behavior | No v2, firmware, cross-channel identity, OS scheduling or unknown-create recovery change | partial; no new physical claim |

The original host regression reproduced six failures before implementation.
The final focused RN recovery/API suite passed 62/62; the v2/API contract suite
passed 7/7. Build, TypeScript, Codegen, package metadata and license checks
passed. The full RN Windows run passed 177/182, with five existing file-URL or
spawn-path failures; checkout-only LF normalization restored the unchanged
Codegen/vector fixtures, and ordinary locked installs corrected stale local
dependencies. Historical API snapshots were not rewritten: the surface test
explicitly enumerates the three new optional properties.

The wire-size follow-up reproduced two failures before implementation, then
passed all 73 affected recovery, API and v2 contract tests plus build and
TypeScript. It covers matching decimal strings without PUT, optional absence,
safe-integer boundaries, malformed values, mismatch retention and ACK-gated
cleanup. This adds no physical or native durability qualification.

Android compiled the complete adapter/test sources against public beta.13, JDK
17, with two Gradle workers. The targeted new journal regression passed,
including boolean preservation and invalid-flag rejection. Its directory
barrier is injected; the earlier full 13-test attempt hit seven raw Windows
path/JSON fixture failures. This is not native filesystem crash qualification.
Apple execution, exact-revision hosted CI, rebuilt native binaries and physical
application acceptance remain separate gates. Historical release evidence
below is unchanged.

### October 7 deferred destination correction (unpublished source)

Demo intentionally prepares an empty destination until native transfer determines
the plaintext/relay route. The previous queue treated that placeholder as usable
because it had no expiry. A fresh attempt passed an empty URL to native HTTP;
a foreground plaintext retry rejected the placeholder relay as a route change.
The queue now obtains scoped credentials before either action. This does not
repair truncated audio or establish that a hash-matched object is playable.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Upload Management §1.1: SDK owns App-mediated recovery | Three red/green tests cover fresh plaintext, fresh relay and retained plaintext destinations | matched at the mocked native boundary |
| Original identity, route and account scope remain fenced | Existing recovery rejection/cancellation tests plus actual transfer-size assertions | matched at the mocked native boundary |
| Cloud acknowledgement precedes file release and device confirmation | Regression asserts completion, native release and foreground confirmation; existing missing-ACK tests remain | matched at the mocked native boundary |
| Usable cloud audio and physical cleanup | Two incident objects and retained native files contain one byte; capture origin remains under investigation | unverified; this credential change is not audio recovery |

Focused recovery suite: 35/35 passed; package metadata, Codegen, TypeScript and
build passed on Windows. Full RN suite: 156 passed, six failed in existing
Windows file-URL/path handling. Codegen's initial comparison failure was checkout
CRLF; normalizing only its local JSON to LF matched the unchanged Git contract.
Hosted exact-revision CI and License Gate are required before integration.
Published beta.12 bytes and installed applications do not include this change.

Red/green regressions were observed for legacy credential persistence, byte
store rejection, premature unlink, expired initial credentials, missing native
size, missing host ACK, duplicate journal ownership, reentrant cancellation,
foreign-file deletion, load-time cleanup of invalid rows, directory-sync
failure, and concurrent completion cleanup. The final deletion-barrier
regressions failed before implementation on both native platforms, then passed
for initial post-unlink sync failure, already-missing retry failure, and successful
restart cleanup. JS coverage verifies that release failure retains completed
metadata until retry succeeds.

Directly observed implementation verification after the deletion-barrier fix:

- `test/upload-recovery.test.mjs`: 32 passing recovery/lifecycle tests.
- `test/upload-recovery-bridge.test.mjs`: 4 passing bridge tests, including
  actual size mapping and rejection of non-array/empty journals and invalid
  date primitives before normalization.
- `test/recording-manager-compatibility.test.mjs`: 6 passing existing tests.
- `BotaDeviceSDKAppleRecordingUploadsTests`: 12 passing focused tests, with
  complete Swift concurrency checking and warnings treated as errors.
- Final RN `npm run verify` passed all 125 tests, including the exact
  frozen-plus-maintenance API surface gate, Codegen, type checking, build, and
  license checks. `git diff --check` passed.
- Android `:adapter:testDebugUnitTest` passed all 41 tests against the fresh
  worktree native Maven artifact, including all 12
  `BotaDeviceSDKAndroidRecordingUploadsTest` cases. The JVM `org.json` dependency
  is installed. This supersedes the earlier stale-native-dependency blocker;
  it does not claim Android device or power-loss qualification.

Final integration also passed the complete RN Swift suite (42 tests, complete
concurrency checking and warnings as errors), Android Codegen/lint/release
assembly, and the CocoaPods consumer build. These runs include both directory
barriers and the failure/retry regressions. Independent read-only review
confirmed that failed cleanup preserves completed metadata until retry succeeds.
