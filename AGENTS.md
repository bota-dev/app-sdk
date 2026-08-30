# AGENTS.md

CI uses the pinned `actions/checkout` 7 and `actions/setup-node` 7 lines. The xtask manifest uses `toml` 1.x; validate future major changes with the full Rust and tooling workflow.

## Repository Purpose

- `app-sdk` is the source monorepo for the **Bota Device SDK** family.
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

## Invariants

- One synchronized SDK version comes from `sdk-version.toml`.
- Rust owns protocol and deterministic workflow behavior.
- Platform transports and lifecycle integration remain native.
- Device SDK code does not call the Bota API directly.
- Unsupported platform capabilities fail before device state changes.
- One workflow owns the core engine at a time; hosts preserve request and
  cancellation IDs when returning callbacks.
- High-volume recording bytes stay off JavaScript and Dart bridges.
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
- Keep `ProtocolFixtures` and `WorkflowFixtures` generated. Run
  `npm run sync:apple-fixtures` instead of editing either resource by hand.
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
npm run sync:apple-fixtures
npm run test:workflows -- --sdk-path ../react-native-sdk
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

- Public prereleases start at `1.0.0-alpha.1`; stable `1.0.0` is reserved for
  the React Native-consumable release. Tags use `vVERSION`.
- Read `docs/releasing.md` before creating or pushing a release tag.
- Only `bota-device-sdk-core` is currently publishable.
- `bota-device-sdk-ffi` is shipping source for native packages but is not a
  standalone registry artifact; no Apple or Android facade is publishable yet.
- The first crates.io publication requires the protected one-time bootstrap
  token; subsequent releases must migrate to Trusted Publishing.
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
