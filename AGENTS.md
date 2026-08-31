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
  and xcodeproj 1.27.0. Run both the local linked-consumer gate and the remote
  exact-version resolution gate when changing pod or Swift-package wiring.
- React Native 0.86.3 duplicates binary Swift-package module maps for static
  pods under Xcode 26.3. The packaged `bota_device_sdk_spm_workaround.rb`
  flattens only `BotaDeviceSDK` and rewrites its aggregate module-map flags.
  Remove it only after the React Native floor includes upstream commit
  `4a6620703c30b3f53917812720528684838d3bbf` and the pinned Xcode gate passes.
- Keep React Native lifecycle serialization in the Swift actor. Concurrent
  configure calls coalesce, destroy waits for an in-flight configure, and the
  Objective-C++ layer only translates generated-spec promises.
- The Android build foundation uses JDK 17, Gradle 8.13, AGP 8.13.2, Kotlin
  2.3.20, API 26 minimum with API 36 compile/lint/test targets, NDK
  28.2.13676358, CMake 3.22.1, and Maven Publish Plugin 0.35.0.
  Linux CI invokes `sdkmanager` from Android command-line tools under
  `$ANDROID_HOME` because GitHub runners do not guarantee it is on `PATH`.
  `platforms/android/gradle.properties` must mirror
  `sdk-version.toml`; release-readiness tests reject version or plugin drift.
- Android dependencies are locked and SHA-256 verified. Normal builds may
  publish unsigned artifacts only to `target/android-m2`; signing must remain
  absent unless `botaProtectedSigning=true` is supplied by a protected release
  environment. The wrapper distribution checksum and the canonical
  `sdk-version.toml`/`VERSION_NAME` equality are enforced. The unpublished AAR
  contains exactly `libbota_device_sdk_ffi.so` and `libbota_android_jni.so` for
  all four supported ABIs, but is not a published facade claim.
  Verification metadata must include the pinned AAPT2 artifact for both macOS
  and Linux so local and GitHub Android builds enforce the same dependency gate.
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
- Keep Android `WorkflowFixtures` generated from all seven canonical workflow
  suites. `preDebugAndroidTestBuild` must reject stale protocol or workflow
  resources before packaged instrumentation runs.
- Keep Android host effects exhaustive. Each effect routes to one typed native
  port, only declared callback kinds may return, and every callback preserves
  the effect's operation, request ID, and cancellation identity. Bound host
  bytes before dispatch and map platform failures to the effect category.
- Recording transfer owns sequence/checkpoint decisions; native hosts own the
  durable sink and validate the final checksum before device deletion.
- Direct-upload fallback requires a fresh inactive device status; busy,
  detached, and unreadable ownership never authorize Bluetooth fallback.
- Firmware retries reuse the host blob but restart BLE delivery at sequence and
  offset zero; current firmware does not support partial Bluetooth OTA resume.
- Device logs subscribe before start, have one workflow owner, and use the
  shared bounded decoder; disconnect cleanup must not attempt a BLE stop write.
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
- Keep manual connect and reconnect policy in the Rust workflows. The Apple
  facade forwards exact identity hints and never chooses a peripheral by name.
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
(cd frameworks/react-native && bundle _2.6.9_ exec npm run test:apple:remote-resolution)
JAVA_HOME=/path/to/jdk-17 ANDROID_HOME="$HOME/Library/Android/sdk" \
  npm run test:android:foundation
tools/android/test-package.sh --api 35 \
  --instrumentation-class dev.bota.sdk.internal.jni.NativeCoreBridgeTest
tools/android/inspect-aar.sh platforms/android/sdk/build/outputs/aar/sdk-release.aar
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
