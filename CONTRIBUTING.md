# Contributing

## Before You Start

Read [AGENTS.md](AGENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), and the active
implementation plan. Protocol and security behavior must agree with the
normative documents in `/Users/zhangqi/ws/bota/internal-docs/device/`.

## Development Workflow

1. Write a focused failing test.
2. Run it and confirm the expected failure.
3. Implement the minimum behavior needed to pass.
4. Run formatting, linting, license, and affected test suites.
5. Update fixtures, compatibility data, and documentation.
6. Commit one coherent behavior change.

## Required Checks

```bash
npm ci
npm run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Dependencies with copyleft or source-available licenses are rejected by both
the npm checker and `cargo-deny`. An exception must identify the exact observed
license and document a completed review; it is not a general package bypass.

Never commit local source links as production dependencies. All released
artifacts must match `sdk-version.toml` and the signed release manifest.
