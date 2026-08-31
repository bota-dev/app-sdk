# AGENTS.md

CI uses the pinned `actions/checkout` 7 and `actions/setup-node` 7 lines. The xtask manifest uses `toml` 1.x; validate future major changes with the full Rust and tooling workflow.

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
- React Native compatibility requires the frozen public API surface digest in
  addition to protocol fixtures and workflow traces. Internal legacy modules
  outside `src/index.ts` are not part of that public contract.
- React Native baseline metadata must match the contract's package, version,
  source revision, normalized path, and surface digest.
- `frameworks/react-native` has its own lockfile, stays private until native,
  compatibility, app, and release gates pass, and pins React Native `0.86.3`
  for deterministic Codegen. Its package version still matches
  `sdk-version.toml`.
- The React Native package matches the 75 frozen `0.0.65` exports that do not
  own native workflows. Keep their structural contract test exact; the five
  deferred runtime classes must delegate to native facades before export.
- The React Native package also exposes the native-backed
  `BotaDeviceSDK.devices` discovery and connection slice. JavaScript preserves
  the frozen scan filters; Apple and Android own scan cancellation and delegate
  selected-device connect, serial-strict reconnect, and disconnect to their
  public native facades. Preserve the frozen unknown pairing-state fallback as
  `unpaired` at both bridge boundaries. This does not make the frozen
  `DeviceManager` class complete or eligible for export.
- Keep the Codegen names `BotaDeviceSDKSpec` and `BotaDeviceSDK` frozen. Import
  uses optional TurboModule lookup; missing native code fails on invocation as
  `native_module_unavailable`, not while the JavaScript module is imported.
- Keep recording and firmware bytes out of React Native Codegen types. Commit
  only the canonical schema and native artifact digests, not generated build
  directories.
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
  device actor owns only its scan task and waits for that collector to finish
  during teardown. Objective-C++ translates generated-spec promises and must
  subclass `NativeBotaDeviceSDKSpecBase` before emitting Codegen events.
- Keep React Native Android lifecycle serialization in
  `BotaDeviceSDKAndroidLifecycle`. Its mutex orders configure and destroy,
  retries a failed configure, and delegates only to `BotaDeviceClient.shared`;
  the generated-spec module translates maps and promises without calling JNI.
- Keep React Native Android discovery and connection serialization in
  `BotaDeviceSDKAndroidDevices`. It owns only its scan coroutine, contains
  asynchronous scan failures, and cancels that scan before connect, reconnect,
  disconnect, destroy, or React Native invalidation.
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
  readiness, fresh installs, animation settings, shutdown, and deletion. Do not
  cache AVD state or put signing material in ordinary CI.
- The protected `v1.1.0` publication uses only
  `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`,
  `SIGNING_IN_MEMORY_KEY`, and `SIGNING_IN_MEMORY_KEY_PASSWORD`. Persist the
  deterministic bundle, inventory, and `central-portal-state.json` on the draft
  GitHub Release before upload. A missing public POM is never an idempotency
  signal: resume by the recorded deployment UUID and state, and use the
  protected recovery dispatch after any uncertain initial upload.
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
- Keep Android `WorkflowFixtures` generated from all seven canonical workflow
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
  original operation failure. Deprovision is a separate remove-only write.
- Store secrets only as AES-GCM ciphertext authenticated by the opaque key;
  Android Keystore owns the non-exportable key. Rust must never receive a path,
  URI, URL, header, token, grant, or Keystore material.
- File and network resources are host registrations consumed by opaque IDs.
  Force recording writes before durable progress, bound firmware reads, close
  every response/descriptor path, and cancel only SDK-owned OkHttp calls.
- Recording transfer owns sequence/checkpoint decisions; native hosts own the
  durable sink and validate the final checksum before device deletion.
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
  compatibility edit. Never publish or package a second legacy coordinate.
- Public Android signatures expose `Flow` and OkHttp `Request`, so coroutines
  and OkHttp remain Maven API dependencies. The clean consumer must compile
  without declaring either dependency itself.
- The compatibility context provider is non-exported and captures only the
  application context. It must never initiate Bluetooth, storage, or network
  work during process startup.
- Native facades use the manually owned opaque C ABI selected in ADR 0001;
  UniFFI `0.32.0` exists only in the non-published comparison spike.
- ABI v1 numeric meanings and ownership rules are frozen by
  `release/evidence/1.0.0-alpha.1-native-abi.md`; facade work may add Swift or
  Kotlin types but must not redesign the C boundary.
- Apple workflow calls pass through one `CoreEngineActor`; host callbacks must
  preserve the effect operation, request ID, and cancellation identity exactly.
- Apple concurrency tests must await explicit callback handshakes; stream
  completion does not order bookkeeping launched in a separate task.
- `BotaDeviceClient.configure()` is idempotent until `destroy()`. Public device
  observation must finish on destroy, and status bytes must use the shared ABI
  decoder rather than a Swift parser.
- Keep manual connect and reconnect policy in the Rust workflows. A
  user-selected peripheral learns its identity from the fresh GATT serial read;
  an explicitly supplied serial and every reconnect remain exact-match checks.
  The Apple facade never chooses a peripheral by name.
- Apple provisioning and reset callbacks are registered by opaque material ID;
  do not place callback results in checkpoints, logs, or public notifications.
- Persist the reset command ID and binding generation with the exact device
  result. Resume only the receipt workflow and reject a stale generation before
  starting Rust. Remove-only deprovision must never call factory reset.
- Direct Apple BLE writes and reducer workflows share one facade operation
  coordinator; release ownership on success, failure, cancellation, and destroy.
- Apple recording, upload-ownership, OTA, and device-log APIs expose typed
  streams and native file URLs only. Keep upload destinations opaque, let only
  the reducer authorize BLE fallback, and unregister OTA host resources on
  every terminal path.
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
