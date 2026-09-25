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
  known, relay route, content type, optional device SHA-256, and an attempt
  `AbortSignal`. Providers must return credentials for the exact original
  recording ID and scope, and must not change the persisted upload route.
  Scope should identify account, project, and environment, never credentials.
- `UploadInfo` adds `recoveryScope`, `alreadyUploaded`, `complete`, `signal`,
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

The journal contains only IDs, native local path, size, scope, route flag,
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

- Startup automatically schedules eligible retained pending files only when
  a recovery provider is configured. Without it, old credentials are discarded
  and tasks wait for scoped foreground sync with fresh credentials.
- Providers are called again after failed attempts. Expired initial credentials
  are disposed and refreshed through the provider before sending bytes. A null
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
