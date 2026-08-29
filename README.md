# Bota App SDK

Source monorepo for the **Bota Device SDK** family. The repository will provide
a shared Rust protocol and workflow core with platform-native Bluetooth
transports and idiomatic Apple, Android, React Native, Flutter, Web, and Windows
facades.

The existing `@bota.dev/react-native-sdk` remains the supported production SDK
until the replacement passes protocol, workflow, native, application, and
physical-device parity gates.

## Current Status

Milestone 1 is implemented at `0.1.0-alpha.1`: the repository has a generated
protocol manifest, 50 language-neutral compatibility fixtures, bounded Rust
decoders, byte-exact serializers, stable models/errors, and a typed workflow
host boundary. It does not publish a supported platform SDK or replace the
production React Native package.

See [ARCHITECTURE.md](ARCHITECTURE.md) and the
[firmware compatibility matrix](protocol/compatibility/firmware-compatibility.json).

## Development

Requirements:

- Node.js 22
- Rust 1.98.0 with rustfmt and Clippy

```bash
npm ci
npm run check
npm run test:fixtures
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo xtask protocol generate --check
```

The full reproducible gate, including the frozen React Native comparator, is
recorded in `release/evidence/`.

## Naming

`app-sdk` is the source repository name. Public physical-device packages belong
to the **Bota Device SDK** family. Future backend API clients belong to a
separate **Bota API SDK** family and repository.

## License

MIT
