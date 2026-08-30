# Bota App SDK

Source monorepo for the **Bota Device SDK** family. The repository will provide
a shared Rust protocol and workflow core with platform-native Bluetooth
transports and idiomatic Apple, Android, React Native, Flutter, Web, and Windows
facades.

The existing `@bota.dev/react-native-sdk` remains the supported production SDK
until the replacement passes protocol, workflow, native, application, and
physical-device parity gates.

## Current Status

The protocol core is versioned at `1.0.0-alpha.1`: the repository has a generated
protocol manifest, 50 language-neutral compatibility fixtures, bounded Rust
decoders, byte-exact serializers, stable models/errors, and deterministic
discovery, connection-recovery, provisioning, authenticated-reset, resumable
recording-transfer, guarded upload-handoff, and resumable firmware-update
reducers, plus exclusive device-log subscription ownership and line delivery.
Twenty-nine canonical workflow scenarios are schema validated, pinned to the
React Native `0.0.65` baseline, and backed by 25 executable Rust tests covering
positive, rejection, cancellation, and resume or restart-recovery behavior.
The native-boundary spike selected a manually owned C ABI after comparing it
with pinned UniFFI `0.32.0`; neither boundary currently ships as a platform
artifact.
It does not publish a supported platform SDK or replace the production React
Native package. The first public artifact is the `bota-device-sdk-core` crate;
platform SDK artifacts will join the synchronized version only after their own
acceptance gates pass.

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
npm run test:workflows -- --sdk-path ../react-native-sdk
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
cargo xtask protocol generate --check
```

The full reproducible gate, including the frozen React Native comparator, is
recorded in `release/evidence/`.

Release maintainers must follow [docs/releasing.md](docs/releasing.md). The
stable `v1.0.0` tag is reserved for the React Native-consumable release.
Prerelease tags must not be pushed until the protected `release` environment
and one-time crates.io bootstrap token are configured.

## Naming

`app-sdk` is the source repository name. Public physical-device packages belong
to the **Bota Device SDK** family. Future backend API clients belong to a
separate **Bota API SDK** family and repository.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and verification rules.
Report vulnerabilities using [SECURITY.md](SECURITY.md), not a public issue.

## License

MIT
