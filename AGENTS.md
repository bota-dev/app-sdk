# AGENTS.md

## Repository Purpose

`app-sdk` is the source monorepo for the Bota Device SDK family. The public
family name is **Bota Device SDK**; the repository name is not a public package
name. The future backend-facing **Bota API SDK** is separate.

Read [ARCHITECTURE.md](ARCHITECTURE.md) and the current plan under
`docs/superpowers/plans/` before making architectural changes.

## Current Authority

Until migration gates pass, `/Users/zhangqi/ws/bota/react-native-sdk` remains
the production behavioral reference. Do not silently reinterpret its protocol
behavior. Capture behavior in language-neutral fixtures and compare bytes.

## Invariants

- One synchronized SDK version comes from `sdk-version.toml`.
- Rust owns protocol and deterministic workflow behavior.
- Platform transports and lifecycle integration remain native.
- Device SDK code does not call the Bota API directly.
- Unsupported platform capabilities fail before device state changes.
- High-volume recording bytes stay off JavaScript and Dart bridges.
- Never infer identity from an advertised BLE name alone.
- Do not treat deprovision or unbind as factory reset.
- Never commit credentials, tokens, private keys, certificate bodies, or signing
  material.

## Development

Use Node.js 22 and the Rust toolchain pinned in `rust-toolchain.toml`.

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

## Releases

- Public releases start at `1.0.0` and use tags shaped as `vVERSION`.
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
