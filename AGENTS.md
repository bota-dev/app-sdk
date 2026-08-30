# AGENTS.md

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
cargo xtask protocol generate --check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

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
