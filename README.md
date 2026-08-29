# Bota App SDK

Source monorepo for the **Bota Device SDK** family. The repository will provide
a shared Rust protocol and workflow core with platform-native Bluetooth
transports and idiomatic Apple, Android, React Native, Flutter, Web, and Windows
facades.

The existing `@bota.dev/react-native-sdk` remains the supported production SDK
until the replacement passes protocol, workflow, native, application, and
physical-device parity gates.

## Current Status

Milestone 1 establishes the repository and pure protocol core. It does not yet
publish a supported platform SDK.

See [ARCHITECTURE.md](ARCHITECTURE.md) and the
[implementation plan](docs/superpowers/plans/2026-08-28-app-sdk-implementation.md).

## Development

Requirements:

- Node.js 22
- Rust 1.98.0 with rustfmt and Clippy

```bash
npm ci
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

## Naming

`app-sdk` is the source repository name. Public physical-device packages belong
to the **Bota Device SDK** family. Future backend API clients belong to a
separate **Bota API SDK** family and repository.

## License

MIT
