# AGENTS.md

CI uses the pinned `actions/checkout` 7 and `actions/setup-node` 7 lines. Keep `workflow_dispatch` plus automatic pull-request and main-push triggers on the CI and license workflows. CI concurrency must preserve every main run and cancel only superseded pull-request runs. Run Android unit tests separately from parallel lint and APK assembly. The xtask manifest uses `toml` 1.x; validate future major changes with the full Rust and tooling workflow. Keep root TypeScript on 6.x while `tools/baseline/react-native-api-contract.mjs` depends on its stable compiler API; TypeScript 7 exposes the replacement compiler API only through `typescript/unstable/*` and requires a deliberate contract-extractor migration. Async teardown and backpressure tests must wait for explicit actor or coroutine signals for each phase, including pump entry before asserting a flow's `finally` block and separate core/host cancellation completion, instead of sampling scheduling-dependent state. Use five-second test-only settlement watchdogs around those signals so loaded CI workers still expose real deadlocks without creating one-second scheduling races. Non-timeout transfer-control tests use a 30-second fixture cleanup deadline because they exercise multi-dispatcher teardown after the release build; dedicated timeout tests inject their own short deadline, and production retains its one-second cleanup contract.

## Repository Purpose

- `app-sdk` is the source monorepo for the **Bota App SDK** family.
- The future backend-facing **Bota API SDK** is a separate family.
- Read [ARCHITECTURE.md](ARCHITECTURE.md) and the active plan under
  `docs/superpowers/plans/` before architectural changes.

## Repository Context

- `AGENTS.md` is the canonical agent context; `CLAUDE.md` is its symlink.
- Keep public architecture in `ARCHITECTURE.md` and contributor workflow in
  `CONTRIBUTING.md`; do not duplicate them here.
- Do not add private repository links, machine-specific paths, or credentials
  to public files.

## Current Authority

- [`@bota.dev/react-native-sdk`](https://github.com/bota-dev/react-native-sdk)
  remains the production behavioral reference until migration gates pass.
- The Bota workspace normally checks it out at `../react-native-sdk`.
- Capture reference behavior in language-neutral fixtures and compare bytes;
  do not silently reinterpret protocol behavior.
- When adding encrypted-upload v2 vectors, update the Android instrumentation
  case count and pinned digest before releasing.
- The target remote-control contract uses one durable, exact `command_id`
  across App/BLE and direct delivery. The released recording-scope Grant plus
  start/stop opcodes is compatibility behavior, not proof of command-bound
  device receipt or completion; see the private Remote Device Control design.
- The semantic TypeScript authority is
  `protocol/baseline/react-native-public-api-0.0.65.json`. A replacement must
  match its exported symbols and reachable public members, including inherited
  EventEmitter and Error instance and static APIs, not only wire bytes. Capture
  and verification require the reference SDK's declaration dependencies to be
  installed from `package-lock.json` with `npm ci`; unresolved modules, missing
  required packages, extras, and version drift are hard failures. npm may omit
  packages that the lock marks optional for the current platform.

## Invariants

- One synchronized SDK version comes from `sdk-version.toml`.
- Rust owns protocol and deterministic workflow behavior.
- Platform transports and lifecycle integration remain native.
- App SDK code does not call the Bota API directly.
- Unsupported platform capabilities fail before device state changes.
- One workflow owns the core engine at a time; hosts preserve request and
  cancellation IDs when returning callbacks.
- High-volume recording bytes stay off JavaScript and Dart bridges.
- The Flutter Dart facade owns one `PigeonBotaPlatform` per engine. It uses
  cryptographically random 32-hex bridge IDs, removes pending operation,
  stream, and callback ownership before completion or cancellation, rejects
  late events and callback responses, and makes destroy terminal and
  idempotent. Dart only maps typed Pigeon values; native facades retain every
  Bluetooth and workflow owner.
- Keep Flutter workflow conformance data-driven from all canonical
  `protocol/workflows/*.json` suites. The fake host may translate a fixture's
  already-decided outcome into typed Dart values, but must not implement a
  second reducer. The current gate discovers all 33 canonical traces, replays
  the 29 Flutter-supported traces, and explicitly classifies the four
  Encrypted Upload v2 traces as unsupported.
- The Flutter example is a real compact device-management screen. Keep scan,
  selected connect, serial-strict reconnect, status, recording list and
  retained encrypted batch handoff, WiFi, OTA, remove-only deprovision, and
  authenticated reset usable without logging credentials, grants, callback
  material, URLs, headers, or recording payloads. Backend stubs fail closed
  until the application integrates them. Do not add native live streaming or
  unsupported Flutter targets.
- The Flutter Android plugin uses the application context and one engine-owned
  `SupervisorJob` on `Dispatchers.Main.immediate`. Its process-wide coordinator
  owns native categories by engine, retains poison after failed native stop,
  and releases ownership only on actual terminal cleanup or final shared-client
  destruction. Keep discovered and connected device handles engine-local. Its
  packaged `android/sdk-version.toml` is resolved from the plugin project and
  must match the root version; package verification rejects drift. Run
  `tools/flutter/test-android-adapter.sh` after changing this bridge.
- A Flutter application owns the Android plugin classpath, so the consumable
  plugin build applies AGP and Kotlin without versions. Standalone plugin and
  adapter-test settings pin AGP 8.13.2 and Kotlin 2.1.20. Keep the build on the
  public `LibraryExtension` and Kotlin compiler-options APIs so generated
  Flutter consumers can compile it with their newer compatible toolchain.
- `tools/flutter/test-consumers.sh` generates disposable full iOS and Android
  applications, validates Bluetooth permission declarations, rebuilds exact
  local Apple and Android artifacts, uses an isolated Gradle cache, and requires
  fresh release outputs. The `dev.bota` Maven group must be exclusive to the
  fresh local repository. Never weaken the gate to accept stale output or a
  remote native substitute. GitHub's pinned macOS runner does not provide
  ripgrep, so this shell gate must use runner-provided tools such as `grep` or
  install any additional command explicitly in the workflow.
- `tools/flutter/package-release.sh --ci` is the automatic PR/main verification
  path. It runs the complete non-publishing Flutter and fresh-consumer gates,
  emits `candidate-ready=false`, and leaves no Flutter release directory only
  for occupied `1.2.0-beta.0`. Selected synchronized `1.2.0-beta.7` emits
  `candidate-ready=true` and preserves the candidate.
  `tools/flutter/package-release.sh --check` is the strict non-publishing
  release gate for beta.1 and later; it must refuse beta.0. It preserves only
  deterministic archive, inventory, lock, license, dry-run, consumer, and
  manifest evidence under
  `target/flutter-release`. Public Flutter Apple metadata has no local override;
  source gates patch only disposable Swift package copies. The archive verifier
  must reject links, traversal, extras, credentials, generated/build output,
  and raw, normalized, or per-file checksum drift.
- Keep `encryptedUploadV2` compatibility metadata at `contract_only` with
  `runtimeWorkflow` and `firmwareAdvertised` false until the remaining
  firmware, published-release, and hardware gates are complete. React Native
  Codegen must not carry ciphertext, manifests, authorizations, or receipts.
- Keep the frozen public API authority in `reactNativeBaseline` at maintenance
  SDK `0.0.65`. Executable workflow evidence uses the separate
  `reactNativeWorkflowBaseline` pinned to maintenance SDK `0.0.67`; CI and tag
  verification must check out that exact revision and run its referenced tests.
  Keep that checkout under the ignored `.ci/` scratch directory, never Cargo's
  `target/`, because the Rust cache action recursively cleans `target/` on a
  cache mismatch.
- `core/device-sdk-core/src/model/upload_profile.rs` is a side-effect-free
  policy/capability validator only. Its presence does not authorize a v2 START
  or change `runtimeWorkflow`; historical P10 requires an observed header.
- `core/device-sdk-core/src/workflow/encrypted_upload_v2.rs` now drives the
  contract-only `WorkflowEngine` and additive C ABI v1 packet surface. It emits
  byte-free native effects, versioned opaque checkpoint metadata, staging
  evidence, and receipt-gated confirmation. The Apple facade maps the additive
  command, all twelve effects, typed failures, and the staged notification to a
  dedicated native host port. Its in-memory `EncryptedUploadV2MaterialRegistry`
  validates the exact 408/580/336-byte opaque documents, bodyless HTTPS staging
  requests, digest evidence, redacted descriptions, duplicate registration,
  stale post-terminal callbacks, and remove-before-cancel terminal cleanup. The
  configured Apple runtime also exposes an internal
  `EncryptedUploadV2CapabilityReader`: every call reads `0406` again, decodes
  the exact 24-byte value through Rust, and returns its SHA-256 with the typed
  bounds. It does not infer support from firmware or model strings. Outbound
  authorization and receipt blob frames must use the shared Rust encoder via
  additive ABI packet kind `0x0523`; platform facades must not reconstruct
  those authenticated frames. Additive kind `0x0524` similarly encodes only
  app-originated v2 LIST, START, WINDOW_ACK, RESUME_REQUEST, CONFIRM, and ABORT
  transfer frames. Transfer decode/encode keeps upload-session UUIDs as exact
  16-byte fields, missing sequences as one packed little-endian u32 byte field,
  and CONFIRM `owner_revision` under its dedicated field. Apple's internal
  mapper exposes Rust-encoded WINDOW_ACK/CONFIRM plus typed Rust-decoded
  DATA, WINDOW_END, MANIFEST_CHUNK, EOF, and ERROR values. The internal
  `EncryptedUploadV2TransferReceiver` builds on that boundary without buffering
  ciphertext: it writes DATA by offset to a protected native file, keeps only
  bounded packet metadata, verifies prefix hashes, truncates unproved resume
  tails, requests exact missing sequences, and will not create a clean
  WINDOW_ACK until the matching native checkpoint, including its highest
  contiguous sequence, is reported persisted. It also
  bounds the manifest to the fixed 580-byte contract and verifies EOF evidence.
  An internal `EncryptedUploadV2TransferHost` now connects that receiver to the
  retained `0409` stream for START/RESUME, DATA/window repair, manifest, EOF,
  abort, protected ciphertext-file writes, and a recoverable native checkpoint
  catalog. It emits structured `WINDOW_STAGED` evidence to Rust and sends only
  Rust-encoded ACK/repair frames through the exact owned transport session. Its
  cancellation teardown closes owned resume and event channels before stopping
  transfer jobs, including when the pump has been created but has not started.
  The platform plus phase-aware transfer queues share a 1 MiB byte cap; overflow,
  premature post-window traffic, mixed profiles, and pre-EOF completion fail
  closed. START/ABORT races cannot resurrect ownership. Host-owned cancellation
  during an in-flight START opening maps to the stable code-16 host error while
  direct caller coroutine cancellation still propagates. Checkpoint lookup
  plus metadata are replaced in one AtomicFile catalog whose file and parent
  directory are flushed before success. Optional internal completion services bind START to the
  prepared authorization and its exact material-registration lease, pass only
  the verified native ciphertext file and fixed manifest to application-owned
  staging/finalization callbacks, require the exact accepted receipt digest,
  durably remove local staging state, deliver the receipt, and then send the
  Rust-encoded CONFIRM. Cancellation ownership is registered before entering
  the asynchronous v2 host callback. The live control actor releases its claimed
  `0409` subscription only after that canonical CONFIRM write. Later
  cancellation or subscription-cleanup uncertainty cannot reverse a successful
  CONFIRM or send ABORT; uncertain cleanup instead poisons the BLE owner until
  confirmed disconnect/reset. Physical power-loss behavior remains unverified. The
  production configuration installs this host with the signed-blob writer,
  transfer-control actor, material registry, and native staging upload service.
  `RecordingManager.syncEncryptedRecordingV2` passes a fresh `0406` capability
  snapshot and matching native checkpoint to an application-owned provider
  before it starts the explicit v2 command. The manager owns cancellation
  before any read or provider await, records cancellation while the Rust engine
  starts and cancels that exact owner before it can consume output or clean up,
  and reuses the checkpoint's exact session, sink, and
  safe negotiated bounds only when its selected material matches. It never
  infers or retries legacy behavior after v2 selection.
  Apple's internal
  `EncryptedUploadV2SignedBlobWriter` permits one owner, queries the actual
  write-with-response limit capped at the 512-byte protocol maximum, subscribes
  to `0407` before BEGIN, checks cancellation between writes, and starts the
  exact kind/`write_id` RESULT timeout only after COMMIT. Cleanup is bounded:
  it best-effort ABORTs plus unsubscribes on local failure, then fails closed
  with `uploadOwnershipUnknown` until a confirmed disconnect if cleanup cannot
  be proven. The internal `EncryptedUploadV2TransferControl` actor similarly
  subscribes to notify-only `0409` before writing canonical START or
  RESUME_REQUEST to `0408`, fails closed on a foreign transport-session ID,
  verifies every echoed
  recording/ciphertext/checkpoint field on START_ACK and RESUME_ACCEPT, and
  preserves the device checkpoint reported by RESUME_REJECT or ERROR. It
  retains the live `0409` stream and serialized owner after acceptance for the
  remaining transfer, and uses bounded ABORT/unsubscribe cleanup with the same
  fail-closed reconnect gate. Android mirrors the same wire ownership through a
  coroutine-serialized signed-document writer and retained `0409` transfer
  control, with every authenticated frame produced by the Rust mapper. Its
  receiver writes bounded DATA windows through `FileChannel`, persists exact
  non-secret resume sidecars with `AtomicFile`, streams only the verified
  ciphertext file through an application-provided empty HTTPS PUT template,
  and gates CONFIRM on manifest submission, finalization, and the exact receipt
  digest. `RecordingManager.syncEncryptedRecordingV2` selects from a fresh
  capability snapshot before command `0x010c`; cancellation owns provider,
  START, staging, and terminal material cleanup without a legacy retry. These
  native implementations do not complete the remaining release or firmware
  gates, so runtime metadata stays false. React Native exposes the same
  explicit selection through additive
  `BotaDeviceSDK.recordings.syncEncryptedRecordingV2`; Codegen carries only
  fresh capability, recording, checkpoint, session, progress, and stable-error
  metadata. Applications register the complete v2 material once in the Apple
  or Android `BotaDeviceSDKEncryptedUploadV2Materials` registry and return only
  its opaque registration ID through JavaScript. Keep `BotaClient`, legacy
   managers and events frozen, and never add an implicit legacy fallback.
- React Native compatibility requires the frozen public API surface digest in
  addition to protocol fixtures and workflow traces. Internal legacy modules
  outside `src/index.ts` are not part of that public contract.
- React Native baseline metadata must match the contract's package, version,
  source revision, normalized path, and surface digest.
- The React Native baseline comparator must route every operation present in
  `protocol/fixtures`; target-core error codes do not replace frozen JavaScript
  parser messages in those comparison expectations.
- `frameworks/react-native` has its own lockfile, is publishable only after its
  native, compatibility, and local app gates pass, and pins React Native
  `0.86.3` for deterministic Codegen. Its package version still matches
  `sdk-version.toml`. Pack and publish with the exact npm CLI in
  `packageManager`; release publication must use the `release.yml` OIDC trusted
  publisher and must verify the registry `dist.shasum` against the candidate.
- The React Native package matches all 80 frozen `0.0.65` exports. Keep their
  structural contract test exact. `BotaClient` serializes native lifecycle
  ownership and composes one compatibility manager graph per ready lifecycle;
  application acceptance and publication gates remain separate. Test local
  consumers from an `npm pack` artifact, not a source symlink: Demo and Bota
  One must each produce release-mode iOS and Android Expo bundles before
  preview or production rollout.
- `frameworks/web` is the foreground browser facade and publishes as
  `@bota.dev/web-sdk`. It uses the shared Rust workflows for exact connection,
  provisioning, recording transfer, encrypted upload v2, firmware update, and
  device logs; TypeScript owns Web Bluetooth, durable browser storage, and
  application provider boundaries. Keep backend calls behind configured
  providers, keep request credentials memory-only, and do not add background or
  closed-tab execution. Every application provider callback receives its
  operation `AbortSignal`; host I/O must honor it, while the SDK stops waiting
  on cancellation, observes late settlement, and ignores late results. A
  missing Web Bluetooth implementation must fail as
  `unsupported_browser` before opening the picker, snapshots must re-verify the
  serial, and OTA reboot recovery may enumerate only the previously verified
  exact browser device ID. OTA reload recovery must validate compatible durable
  journal/checkpoint/blob state before GATT, use that exact authorized device for
  every disconnected active phase, and persist the one-way journal
  `cleanup_only` state before terminal checkpoint deletion so reload performs
  cleanup without provider or device work. One public Web client owns one
  runtime/coordinator and one instance of each manager. Read-only construction
  needs no storage or provider; durable workflows require a non-empty tenant
  namespace, and custom storage must match it exactly. Client destruction is
  terminal, joins picker and reconnect-hint startup work, and joins every
  non-device owner and passive subscription before the one final disconnect.
  Teardown must exhaustively settle all manager cleanup in declaration order,
  runtime destruction, and final disconnect even after an earlier failure;
  reject only afterward with the first normalized cleanup error, and keep
  repeated destroy calls on the same terminal promise.
  OTA active resume phases and passive WiFi status setup must freshly verify
  the exact active serial before provider, mutation, or characteristic work.
  Root manager names are instance types only; applications obtain managers
  from `BotaDeviceClient`, not constructors. Tenant cleanup is BLE-free,
  requires no active owner, and remains available after destroy for logout
  ordering. Keep the release gate on npm 12.0.2 and Playwright 1.63.0 with
  Chromium only. `npm run web:verify` must pack once, reject unsafe package
  headers and contents without extracting it, and produce the checksum-bound
  inventory in that single archive verification. Install only that tarball
  into the Vite consumer; the browser stage must not parse the archive again,
  and instead validates the original inventory checksum, source revision,
  tarball identity, and installed regular-file hashes before testing the
  production ESM/WASM copy. Preserve `target/web-release` and its hash
  inventory unchanged through protected `release.yml` npm OIDC publication.
  Treat `docs/testing/web-physical-device.md` as a separate supervised release
  gate: fake Bluetooth in automated Chromium is never physical evidence. The
  Web hardware acceptance remains open while any required row is `NOT RUN` or
  failed. `1.2.0-beta.7` alone has release-owner authorization to publish as a
  beta before this matrix; do not treat publication as hardware acceptance.
  Do not advertise background or closed-tab work, live streaming,
  authenticated factory reset, Safari/iOS fallback, Flutter Web, or Windows as
  Web capabilities.
- Web device logs have one Rust workflow owner and one diagnostics
  characteristic lease. Resolve subscription setup only after Rust reaches its
  running state, expose only typed Rust `DeviceLog` notifications, and join
  pending subscribe/write cleanup before releasing callbacks or ownership.
  Preserve the canonical Rust behavior that ignores undersized packets without
  resetting sequence state, while sanitizing genuine Rust, bridge, and runtime
  failures. Synchronous throws and rejected promise-like listener results must
  disable delivery and cancel the exact workflow.
- `RecordingManager` and `StreamingSession` preserve their frozen object model
  while Rust plus the Apple/Android hosts own recording bytes, live-transfer
  buffering, chunk uploads, finalization ordering, and cancellation. Codegen
  carries only request IDs, destinations, metadata, state, and progress.
- The root React Native `DeviceManager` compatibility export preserves scan,
  selected-device connection, status, settings, logs, WiFi, cache, serialized
  reconnect, and auto-reconnect behavior over the native facades. Keep its
  zero-argument constructor and exact semantic class surface frozen.
- `BotaDeviceSDK.controls` and the internal `DeviceManager` now delegate
  provisioning-state, device-public-key, auth-nonce, API-endpoint,
  certificate, backend-public-key, recording-grant, and time-sync commands to
  native `DeviceControlManager` facades. The controls facade also delegates
  grant-gated recording start/stop, recording-state reads, and one owned
  recording-state stream; Codegen carries only typed results and state. Keep
  public keys as typed native bytes below Codegen and keep certificate chunk
  framing plus recording-control BLE sequencing native. The compatibility
  owner preserves the frozen grant-fetcher overloads, pending-state precedence,
  state cache fallback, and synchronous subscription removal. Authenticated
  reset and reinstall-safe receipt recovery are native-backed, and the exact
  class surface passes as a root export.
- The React Native package also exposes the native-backed
  `BotaDeviceSDK.devices` discovery, connection, and device-status slice.
  JavaScript preserves the frozen scan filters and status date mapping; Apple
  and Android own scan/status cancellation and delegate selected-device
  connect, serial-strict reconnect, disconnect, status reads, and status
  subscriptions to their public native facades. A private disconnect event from
  the native status stream drives the compatibility owner's single serialized
  reconnect loop; explicit user disconnect pauses it. Preserve frozen
  unknown-value fallbacks at both bridge boundaries: pairing state is
  `unpaired`, device state is `idle`, and LTE/WiFi status is `off`.
- `BotaDeviceSDK.provisioning` is the native-backed provisioning slice.
  Provisioning material stays nonce-bound: native emits a one-shot request ID,
  serial, nonce, and public device key while the workflow is active; JavaScript
  resolves that request with the API endpoint, device token, and MTU or rejects
  it with an application error. Never split this into a read-then-provision
  sequence. Deprovision is remove-only and must remain separate from factory
  reset, but it is still authenticated: native code writes the decoded
  nonce-bound grant, subscribes to the provisioning result, then writes opcode
  `0x05` and returns the typed firmware result. Destroy and invalidation must
  reject pending material requests and cancel the native provisioning
  operation.
- `BotaDeviceSDK.provisioning.writeConnectionSettings` accepts the frozen
  `DeviceConnectionSettings` shape. JavaScript expands omitted heartbeat,
  power-management, streaming, and flush-interval defaults before Codegen;
  the frozen heartbeat default enables both WiFi and cellular independently of
  `enabled_connections`.
  Apple and Android then normalize the complete settings for the device model
  and own serialization plus the BLE write. Keep encoded settings bytes out of
  Codegen, and preserve heartbeat channel selection independently from upload
  preference.
- `BotaDeviceSDK.provisioning.readConnectionSettings` performs the
  characteristic read and shared decoding in the native facade. Codegen carries
  only the complete typed settings value; JavaScript restores the frozen
  snake-case field names and filters unknown future connection types.
- `BotaDeviceSDK.factoryReset` delegates the authenticated reset reducer to the
  native facades. JavaScript resolves a one-shot request containing the fresh
  nonce, command ID, and binding generation with the backend's encoded grant;
  native code decodes the grant and owns all BLE bytes. Resume accepts the
  current binding generation and runs only native receipt recovery. Destroy and
  invalidation reject pending grants and cancel the active reset operation.
- Reinstall-safe reset resume may begin without a native journal. It waits for
  the exact successful firmware replay, durably re-persists that result through
  the application hook, and only then sends receipt opcode `0x0A`; it never
  requests another grant or resends reset opcode `0x06`.
- `BotaDeviceSDK.recordings` delegates recording list, transfer, and upload
  ownership to the native facades. Codegen carries metadata, opaque upload
  identifiers, progress, and the native ownership decision only; completed
  audio remains in native storage and JavaScript receives a file path. Only
  the native reducer may authorize Bluetooth fallback. Destroy and invalidation
  cancel the active native recording operation. Preserve the frozen `opus_16k`
  fallback for unknown codec values.
- `BotaDeviceSDK.ota` accepts a presigned firmware URL plus version and byte
  size. Apple and Android generate the opaque download registration ID,
  calculate CRC32 from the native download bytes after durable storage, and run
  the native OTA workflow. Codegen emits only phase and byte progress; firmware
  bodies never cross JavaScript. Destroy and invalidation cancel the active
  native OTA operation.
- `BotaDeviceSDK.logs` delegates device-log subscription to the native facades.
  Apple and Android own BLE packet framing, sequence recovery, UTF-8 assembly,
  and cancellation. Codegen emits only complete sanitized `message` and
  `isBacklog` values, which JavaScript maps to the frozen `DeviceLogEvent`
  shape. Subscribe before starting native logs, and stop native ownership
  exactly once when the asynchronous subscription is removed.
- `BotaDeviceSDK.wifi` delegates configuration, disconnect, status reads,
  status subscriptions, and device-side scans to the native facades. JavaScript
  carries typed credentials and the encoded application grant but never BLE
  packet bytes. Apple and Android subscribe before result-producing writes,
  share the Rust status and scan decoders, preserve unknown status as frozen
  `idle`, and stop each owned notification stream exactly once.
- Keep the Codegen names `BotaDeviceSDKSpec` and `BotaDeviceSDK` frozen. Import
  uses optional TurboModule lookup; missing native code fails on invocation as
  `native_module_unavailable`, not while the JavaScript module is imported.
- Keep recording bytes, firmware bytes, and raw device-log packets out of React
  Native Codegen types. Commit only the canonical schema and native artifact
  digests, not generated build directories.
- The React Native Apple pod uses the React Native 0.86 iOS 15.1 floor and
  requires CocoaPods 1.13 or newer. It resolves the exact matching
  `BotaAppleSDK` release by default; `BOTA_APPLE_SDK_PACKAGE_PATH` is only for
  local source and CI verification.
- React Native Apple CI selects Xcode 26.3 and Ruby 3.3.12 and uses
  `frameworks/react-native/Gemfile.lock` for Bundler 2.6.9, CocoaPods 1.16.2,
  and xcodeproj 1.27.0. Main-branch lifecycle and linked-consumer gates use the
  nested local package at `platforms/apple/Package.swift` because the
  repository-root package resolves a release binary URL that does not exist
  before publication. `test:apple:lifecycle` builds that package's XCFramework
  first, so it also works in a clean checkout. The tag release must run the
  remote exact-version consumer only after the GitHub Release is public.
- React Native 0.86.3 duplicates binary Swift-package module maps for static
  pods under Xcode 26.3. The packaged `bota_device_sdk_spm_workaround.rb`
  flattens only `BotaDeviceSDK` and rewrites its aggregate module-map flags.
  Remove it only after the React Native floor includes upstream commit
  `4a6620703c30b3f53917812720528684838d3bbf` and the pinned Xcode gate passes.
- Keep React Native lifecycle serialization in the Swift actor. Concurrent
  configure calls coalesce, destroy waits for an in-flight configure, and the
  device actor owns its scan and status tasks and waits for those collectors to
  finish during teardown. `BotaDeviceSDKAppleLogs` owns the single native log
  stream and waits for its collector during explicit stop or destruction.
  `BotaDeviceSDKAppleSecurity` owns one-shot
  provisioning continuations and cancels them during teardown. Objective-C++
  translates generated-spec promises and must subclass
  `NativeBotaDeviceSDKSpecBase` before emitting Codegen events.
- Keep React Native Android lifecycle serialization in
  `BotaDeviceSDKAndroidLifecycle`. Its mutex orders configure and destroy,
  retries a failed configure, and delegates only to `BotaDeviceClient.shared`;
  the generated-spec module translates maps and promises without calling JNI.
- Keep React Native Android device serialization in
  `BotaDeviceSDKAndroidDevices`. It owns scan and status coroutines, contains
  asynchronous stream failures, and cancels affected work before connect,
  reconnect, disconnect, destroy, or React Native invalidation.
- Keep React Native recording stream ownership in
  `BotaDeviceSDKAndroidRecordings`. Collect the public facade flow natively,
  emit only progress, and return the completed native path plus actual
  transfer E2E and optional SHA-256 metadata. Never infer relay ownership from
  the recording-list encryption flag. React Native batch sync retains the
  device copy and sends the exact native confirm only after upload succeeds.
  The future three-profile migration is defined in
  [`Encrypted Upload v2`](../internal-docs/device/Encrypted-Upload-v2.md): v2
  selection must be explicit and capability-gated, bytes and manifests remain
  opaque, and a failed v2 session never silently downgrades.
- Keep React Native device-log stream ownership in
  `BotaDeviceSDKAndroidLogs`. It owns one native collector, contains
  asynchronous stream failures, and stops that collector during explicit
  removal, destroy, or React Native invalidation.
- Keep React Native Android provisioning and factory-reset material ownership
  in `BotaDeviceSDKAndroidSecurity`. Request IDs are one-shot, material is
  copied into the public Android facade, factory-reset result persistence must
  resolve before the native receipt can be written, and destroy/invalidation
  cancels pending deferred values plus both active native workflows.
- The Android build foundation uses JDK 17, Gradle 8.13, AGP 8.13.2, Kotlin
  2.1.20, API 26 minimum with API 36 compile/lint/test targets, NDK
  28.2.13676358, CMake 3.22.1, and Maven Publish Plugin 0.35.0.
  Kotlin and coroutines are compatibility pins for the React Native 0.86.3
  floor, so Android lint intentionally disables only dependency-update advice.
  Linux CI invokes `sdkmanager` from Android command-line tools under
  `$ANDROID_HOME` because GitHub runners do not guarantee it is on `PATH`.
  `platforms/android/gradle.properties` must mirror
  `sdk-version.toml`; release-readiness tests reject version or plugin drift.
- Android dependencies are locked and SHA-256 verified. Normal builds may
  publish unsigned artifacts only to `target/android-m2`; signing must remain
  absent unless `botaProtectedSigning=true` is supplied by a protected release
  environment. The opt-in accepts only the exact string `true` and requires
  password-protected in-memory key material before the raw repository exists.
  Keep raw Gradle staging, normalized Central Portal files, and release outputs
  in separate `target/` roots; the signed Portal ZIP must contain exactly the
  inventory's 30 files. The wrapper distribution checksum and the canonical
  `sdk-version.toml`/`VERSION_NAME` equality are enforced. The release-candidate
  AAR contains exactly `libbota_device_sdk_ffi.so` and
  `libbota_android_jni.so` for all four supported ABIs. Add Android to
  `publishedFacades` only after Central reports `PUBLISHED`, every remote byte
  matches the signed inventory, and both public emulator consumers pass.
  Verification metadata must include the pinned AAPT2 artifact for both macOS
  and Linux, plus parent/BOM metadata resolved only by a cold Linux graph, so
  local and GitHub Android builds enforce the same dependency gate.
- `protocol/baseline/android-maven-license-policy.json` is the reviewed license
  authority for published Maven dependencies. Package generation must copy
  those licenses into the SPDX document, and the license workflow must reject
  an unreviewed coordinate, version, or SPDX license.
- The shared npm license checker scans whichever package invokes it. Its extra
  Android release-tool pin check belongs only to the root
  `@bota.dev/app-sdk-workspace`; nested React Native verification must not be
  required to install root-only ZIP and XML tooling.
- Android CI packages once, reconstructs `target/android-m2` from that exact
  `target/android-release` payload, passes the immutable repository through the
  React Native Codegen/Kotlin consumer, then runs the API 26 x86 and API 35
  x86_64 emulator lanes. `test-emulator-lane.sh` owns AVD creation, boot
  readiness, fresh installs, animation settings, shutdown, and deletion. It
  exports one lane-local `ANDROID_AVD_HOME` for both `avdmanager` and the
  emulator, bounds ADB attachment, detects exited background emulator jobs,
  and prints the captured emulator output on startup failure. Before either
  emulator starts, all source, frozen-binary,
  and clean Maven consumers must compile against the exact installed candidate
  repository. Android JUnit instrumentation methods must return `Unit`
  explicitly when an expression body could infer another return type. Do not
  cache AVD state or put signing material in ordinary CI.
- The protected `v1.1.0` publication uses only
  `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`,
  `SIGNING_IN_MEMORY_KEY`, and `SIGNING_IN_MEMORY_KEY_PASSWORD`. Persist the
  deterministic bundle, inventory, and `central-portal-state.json` on the draft
  GitHub Release before upload. A missing public POM is never an idempotency
  signal: resume by the recorded deployment UUID and state, and use the
  protected recovery dispatch after any uncertain initial upload.
- PGP signatures include their creation time, so a protected rerun must not
  rebuild or replace the preserved Central ZIP. Uncertain deployments resume
  by UUID without another upload. A confirmed `FAILED` deployment may be
  superseded only through `centralRecoveryMode=retry-failed`, which verifies
  the failed UUID and re-uploads the exact preserved ZIP under a fresh state
  record containing `retryOfDeploymentId`. Recovery also requires the original
  tag workflow `releaseRunId`; it downloads the Apple, Android, React Native,
  and Web platform artifacts, matches their subset of the five-platform
  candidate inventory,
  then completes npm, the native-bootstrap GitHub prerelease, and the public
  Apple and Android consumer gates. Central recovery never rebuilds or publishes
  Flutter.
- Create annotated release tags only from the `release-candidate-<commit>`
  inventory emitted by successful main CI. The beta.0 inventory intentionally
  omits Flutter and is not taggable. The selected beta.1 inventory binds Apple,
  Android, React Native, Web, and Flutter candidates. The tag workflow must
  retrieve that exact CI inventory, compare each rebuilt native and Flutter
  subset, and preserve its digest. Local builds are preflight evidence, not
  release identity.
- Keep mutating Android release-readiness tests in independent temporary
  fixtures. They run in parallel, so fixture names require an atomic uniqueness
  component in addition to wall-clock time.
- Keep Android JNI as an ownership adapter only. Pass primitive typed fields
  and raw byte arrays or direct buffers; copy Rust-owned packets and errors
  before exactly one matching free. Test counters belong to debug builds only.
- Keep Android Bluetooth framework objects and mutable callback state on the
  `bota-bluetooth` HandlerThread. Serialize GATT work per peripheral, preserve
  generation checks, and let disconnect cancel queued work. Advertised names
  are display metadata, never reconnect identity.
- Bluetooth permission behavior must remain device-tested on API 26 and API 35:
  location through API 30, then `BLUETOOTH_SCAN` plus `BLUETOOTH_CONNECT` on
  API 31+. The SDK reports missing permissions but never prompts.
- Android workflow calls pass through one closeable `CoreEngineRuntime` and one
  dedicated coroutine dispatcher. Every JNI call stays on that dispatcher;
  Rust owns concurrent-command rejection, and host callbacks preserve the
  original operation, request ID, and both cancellation-ID halves.
- Android `BotaDeviceClient.configure()` is idempotent until `destroy()` and
  retains only the application context. Check Bluetooth authorization before
  starting Rust, learn identity from GATT for a user-selected peripheral,
  preserve exact serial verification when one is supplied, forward reconnect
  hints without name-based selection, decode status through the
  shared mapper, and finish every connection/status observer on destroy.
- Android scan flows acquire workflow ownership only when collected; each
  collection owns a fresh cancellation ID. Bind active work and status cleanup
  to the runtime generation that created it so late callbacks cannot restore
  state after destroy/reconfigure, and disable status notifications only after
  the last collector for that runtime and peripheral leaves.
- Android runtime construction and destroy must attempt every owned close
  action even when one close fails. Preserve the first cleanup failure and add
  later failures as suppressed exceptions.
- Encrypted Upload v2 cancellation remains ordinary until the native host
  atomically begins the canonical CONFIRM write. Only after that real boundary
  do Apple and Android wait for exact completion or code-19 uncertainty without
  invoking host rollback. When cancellation races the return from Apple engine
  startup, only exact Completed or code 19 preserves terminal material; an
  ordinary cancel failure after a pre-CONFIRM claim removes it as cancelled.
  Android records a successful driver write in host state before releasing the
  transfer owner. Confirmed-disconnect reset installs the host replacement
  barrier before it enters the DeviceRuntime mutex to validate the generation
  and remove the exact control/writer owners. It leaves that mutex before it
  waits for confirmation settlement, detaches and fails the exact old channels,
  and joins its opening/pump jobs before admitting a replacement. Android validates
  transfer phase at notification arrival, broadcasts bounded platform
  notifications to every active observer, and resets poisoned ownership on
  an exact peripheral/GATT-generation confirmed disconnect. Its atomic checkpoint
  catalog merges every valid earlier split checkpoint/index pair, including when
  a catalog or only its AtomicFile backup already exists.
- Keep Android `WorkflowFixtures` generated from all eight canonical workflow
  suites. `preDebugAndroidTestBuild` must reject stale protocol or workflow
  resources before packaged instrumentation runs.
- Keep Android host effects exhaustive. Each effect routes to one typed native
  port, only declared callback kinds may return, and every callback preserves
  the effect's operation, request ID, and cancellation identity. Bound host
  bytes before dispatch and map platform failures to the effect category.
- Keep Android checkpoints, reconnect identity, and factory-reset receipts in
  non-secret AtomicFile journals. Reset deletion must match the exact command;
  bind saved results to the registered binding generation.
- Android provisioning and reset callbacks use random opaque material IDs and
  share one facade operation coordinator with connection and direct-write
  workflows. Registration failure, cancellation, detach, and destroy must
  release every registration and owner; cleanup failure must not hide the
  original operation failure. Deprovision is a separate remove-only workflow;
  it must never send opcode `0x05` without first writing the application grant.
- Store secrets only as AES-GCM ciphertext authenticated by the opaque key;
  Android Keystore owns the non-exportable key. Rust must never receive a path,
  URI, URL, header, token, grant, or Keystore material.
- File and network resources are host registrations consumed by opaque IDs.
  Force recording writes before durable progress, bound firmware reads, close
  every response/descriptor path, and cancel only SDK-owned OkHttp calls.
- Recording transfer owns sequence/checkpoint decisions; native hosts own the
  durable sink and validate the final checksum before device deletion.
  Encrypted batch transfer writes the 32-byte ephemeral public key, 4-byte
  salt, and two-byte plaintext-length-prefixed ciphertext chunks directly to
  that sink. Reject mixed plaintext/encrypted sessions and encrypted chunks
  received before their session header.
- Android recording, upload-ownership, OTA, and log APIs are cold `Flow`s.
  Keep recording and firmware bytes in native files, return only paths and
  typed progress/ownership/line values, and release the original cancellation
  ID, registration, and shared operation owner on every terminal path.
- Pair each Android OTA download registration with one firmware-blob
  registration over the same native path. The public `FirmwareImage` may carry
  an OkHttp `Request`; URLs and headers must never enter core packets.
- Direct-upload fallback requires a fresh inactive device status; busy,
  detached, and unreadable ownership never authorize Bluetooth fallback.
- Firmware retries reuse the host blob but restart BLE delivery at sequence and
  offset zero; current firmware does not support partial Bluetooth OTA resume.
- Device logs subscribe before start, have one workflow owner, and use the
  shared bounded decoder; disconnect cleanup must not attempt a BLE stop write.
- Keep the one-major `com.bota.sdk` adapter descriptor-compatible with pinned
  Android revision `0f06d2a22c55e4976778520cce42230d23ca4226`. Run the frozen
  `javap`, Kotlin API, source-consumer, and precompiled-binary gates after every
  compatibility edit. The checked-in consumer JAR must use the Kotlin metadata
  major/minor derived from the pinned legacy-consumer compiler so that the
  compatibility lane can compile it. Never publish or package a second legacy
  coordinate.
- Public Android signatures expose `Flow` and OkHttp `Request`, so coroutines
  and OkHttp remain Maven API dependencies. The clean consumer must compile
  without declaring either dependency itself.
- The compatibility context provider is non-exported and captures only the
  application context. It must never initiate Bluetooth, storage, or network
  work during process startup.
- Native facades use the manually owned opaque C ABI selected in ADR 0001;
  UniFFI `0.32.1` exists only in the non-published comparison spike.
- ABI v1 numeric meanings and ownership rules are frozen by
  `release/evidence/1.0.0-alpha.1-native-abi.md`; facade work may add Swift or
  Kotlin types but must not redesign the C boundary.
- Apple workflow calls pass through one `CoreEngineActor`; `run` establishes the
  ABI workflow owner and drains initially queued effects through host
  registration before returning its stream. Host callbacks preserve the effect
  operation, request ID, and cancellation identity exactly.
- Apple concurrency tests must await explicit callback handshakes; stream
  completion does not order background host-effect bookkeeping.
- `BotaDeviceClient.configure()` is idempotent until `destroy()`. Public device
  observation must finish on destroy, and status bytes must use the shared ABI
  decoder rather than a Swift parser.
- Keep manual connect and reconnect policy in the Rust workflows. A
  user-selected peripheral learns its identity from the fresh GATT serial read;
  an explicitly supplied serial and every reconnect remain exact-match checks.
  The Apple facade never chooses a peripheral by name.
- Apple provisioning, reset, and Encrypted Upload v2 callbacks are registered
  by opaque material ID; do not place callback results in checkpoints, logs, or
  public notifications. V2 terminal cleanup removes the callback before any
  best-effort backend cancellation can fail.
- Persist the reset command ID and binding generation with the exact device
  result. Resume only the receipt workflow and reject a stale generation before
  starting Rust. Remove-only deprovision must never call factory reset.
- Direct Apple BLE reads/writes and reducer workflows share one facade operation
  coordinator. Per-peripheral gate waiters support grant before continuation
  registration, and CoreBluetooth cancellation removes queued callbacks before
  changing request state; both terminate exactly once without releasing another
  task's gate ownership or swallowing a notification. Failed native cancellation retains category ownership until
  the original operation ends or shared-client destruction proves cleanup. A
  cancelled read characteristic stays quarantined while notifications remain
  active; notifications continue to their subscriber, and only an unambiguous
  stale response or disconnect clears the read boundary. Track native stream
  startup before coordinator acquisition, then cancel and await that exact task before the
  post-start stop can prove cleanup. A failed startup with no stream is terminal,
  but a returned stream requires successful stop or final client destruction. Stream collector completion is not
  native-terminal proof when the corresponding stop throws. During detach,
  reject registered application callbacks and await their exact owning one-shot
  before native cancellation; operations whose provider has not registered must
  still receive native cancellation first so they can unwind.
- Apple recording, upload-ownership, OTA, and device-log APIs expose typed
  streams and native file URLs plus bounded transfer-completion metadata only.
  Keep upload destinations opaque, let only the reducer authorize BLE fallback,
  retain batch recordings until the application upload succeeds, and unregister
  OTA host resources on every terminal path.
- Add new ABI effects to the exhaustive `CoreEffect` and `HostEffectExecutor`
  switches. Never route a new kind through a default branch.
- Keep CoreBluetooth objects inside `CoreBluetoothDriver`'s dedicated serial
  queue. The actor host may exchange only value records and must serialize BLE
  work per peripheral while allowing disconnect to fail blocked work.
- Keep Apple URLs, headers, file paths, Keychain values, and material callbacks
  behind native opaque-ID registries. Core checkpoints may contain workflow
  state only; recording integrity uses the protocol's CRC32.
- Keep Apple physical tests opt-in and serial verified. The default path must
  skip before configuring `BotaDeviceClient`; feature-changing operations need
  their individual gates, and authenticated reset additionally needs
  `BOTA_ALLOW_FACTORY_RESET=1` plus a command-bound grant.
- Keep Apple `ProtocolFixtures` and `WorkflowFixtures` and Android
  `ProtocolFixtures` generated. Run `npm run sync:apple-fixtures` and
  `npm run sync:android-fixtures` instead of editing resources by hand.
- Never infer identity from an advertised BLE name alone.
- Do not treat deprovision or unbind as factory reset.
- Never commit credentials, tokens, private keys, certificate bodies, or signing
  material.

## Development

- Use npm with Node.js 22: `npm ci`, `npm run check`, `npm run test:tooling`.
- Use Cargo with the toolchain pinned in `rust-toolchain.toml`.

```bash
npm ci
npm run check
npm run test:release
npm run web:verify
npm run baseline:react-native:api -- --sdk-path ../react-native-sdk
npm run sync:android-fixtures
npm run sync:apple-fixtures
npm run test:workflows -- --sdk-path ../react-native-sdk
(cd frameworks/react-native && npm ci && npm run verify)
(cd frameworks/react-native && npm run test:apple:lifecycle)
(cd frameworks/react-native && bundle _2.6.9_ install)
(cd frameworks/react-native && bundle _2.6.9_ exec npm run test:apple:integration)
# Run only after the matching public tag and Apple archive exist:
(cd frameworks/react-native && bundle _2.6.9_ exec npm run test:apple:remote-resolution)
tools/flutter/run-flutter.sh test frameworks/flutter/bota_flutter_sdk/test
tools/flutter/test-android-adapter.sh
tools/flutter/test-consumers.sh
npm run flutter:verify
tools/flutter/package-release.sh --check
JAVA_HOME=/path/to/jdk-17 ANDROID_HOME="$HOME/Library/Android/sdk" \
  npm run test:android:foundation
tools/android/test-package.sh --api 35 \
  --instrumentation-class dev.bota.sdk.internal.jni.NativeCoreBridgeTest
tools/android/inspect-aar.sh platforms/android/sdk/build/outputs/aar/sdk-release.aar
tools/android/test-publication-graphs.sh
tools/android/package-release.sh --check
tools/android/verify-publication.sh target/android-release
tools/android/install-release-repository.sh target/android-release target/android-m2
tools/android/test-emulator-lane.sh --api 26
tools/android/test-emulator-lane.sh --api 35
cargo xtask protocol generate --check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
tools/ffi-smoke/run-native-c-smoke.sh
tools/ffi-smoke/run-native-swift-smoke.sh
tools/apple/test-package.sh
tools/apple/test-consumer.sh
tools/apple/package-release.sh
```

Use `docs/testing/apple-physical-device.md` only for supervised lab runs. Do not
set physical-test variables in CI or claim physical verification from skipped
tests.

Some commands become available in later milestones. Run all commands applicable
to the files currently present.

## Commit Attribution

AI commits MUST include:

```text
Co-Authored-By: OpenAI Codex <noreply@openai.com>
```

## Releases

- Stable `1.0.0` is the first public Apple package release. It does not claim
  React Native, Android, Flutter, Web, or Windows facade availability. Tags use
  `vVERSION`.
- The private React Native foundation is not a release artifact and must not be
  added to a release manifest or published to npm before Milestone 4 exits.
- Read `docs/releasing.md` before creating or pushing a release tag.
- Prepared `1.2.0-beta.0` metadata and evidence do not claim publication. That
  identity is occupied by immutable non-Flutter source and must not be reused.
  Immutable `v1.2.0-beta.1` and `v1.2.0-beta.2` were tagged but their release
  workflows failed; never move or reuse them. Beta.2 stopped before publication
  on a candidate-inventory projection that dropped `schemaVersion`.
  `v1.2.0-beta.3` is also immutable: Central published, but npm and Apple did
  not after the HTML-index timeout and a signed-bundle mismatch on retry.
  `v1.2.0-beta.4` is immutable and unpublished: the tagged Android unit suite
  failed twice before the protected publish job.
  `v1.2.0-beta.5` is immutable and unpublished: the tagged Android unit suite
  stalled and the run was cancelled before publication.
  `v1.2.0-beta.6` is immutable and unpublished: tagged Android unit tests
  failed before the protected publish job.
  `1.2.0-beta.7` is the selected synchronized candidate. Its publication
  requires green automated gates and protected approval. It and later betas
  use the protected release workflows and verify occupied versions instead of
  attempting to replace them.
  Beta.3 Central is `PUBLISHED` with all 30 file hashes verified, but its tagged
  workflow stopped before npm and Apple publication on a missing HTML directory
  index. Do not mistake this partial Maven publication for a complete release.
- The public Apple package is the root `Package.swift`; keep the nested
  `platforms/apple/Package.swift` for local development against the generated
  XCFramework.
- New release evidence uses manifest version 2 with `sdkFamily` set to
  `bota-app-sdk`; each artifact's `platform` and `packageIdentifier` must match
  the public matrix in `README.md`.
- Customer-facing packages use the public names in `README.md`.
  `bota-device-sdk-core`, `bota-device-sdk-ffi`, `BotaDeviceSDKC`, and
  `bota_device_sdk_v1_*` remain internal implementation names; the Rust crates
  are not published to crates.io by this workflow.
- The protected `release` environment is the human approval gate for external
  hardware acceptance. CI never manufactures physical-device evidence.
- Never push a release tag until `cargo xtask release verify-tag vVERSION`,
  package verification, and all quality gates pass.

## Change Discipline

- Write a failing test before production behavior.
- Keep protocol facts in `protocol/manifest/`; generated constants are not
  hand-edited.
- Every behavior change updates fixtures, compatibility data, architecture or
  feature documentation, and the relevant public docs in the same change.
- Keep commits focused by protocol family or workflow.
- Do not switch Demo or Bota One to this repository before the plan's app
  acceptance milestone.
