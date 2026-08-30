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
with pinned UniFFI `0.32.0`. The versioned shipping crate now maps every core
command, host event, host effect, and workflow notification through typed
packets. Shared protocol decode/encode entry points cover the frozen status,
recording, transfer, OTA, provisioning, settings, and log fixtures, but no
native platform artifact is published yet.
ABI v1 is frozen at the typed public header and verified by standalone C and
Swift callers. Its exact ownership contract, artifact digests, packet coverage,
and platform exclusions are recorded in
[`release/evidence/1.0.0-alpha.1-native-abi.md`](release/evidence/1.0.0-alpha.1-native-abi.md).
The Apple package shell now builds an iOS device, universal iOS simulator, and
universal macOS XCFramework from that frozen header and proves a Swift package
can import the real ABI. Its Swift value models and protocol codecs are fixture
tested against the shared Rust implementation, including unknown wire values
and Bota Note connection normalization. A serialized Swift actor now drives the
real Rust workflow engine, preserves request/cancellation correlation, and
checks all 29 canonical workflow traces from generated SwiftPM resources. Its
host executor exhaustively routes all 30 ABI effect kinds through narrow native
ports, bounds raw payloads, and isolates cancelled or late completions.
A concrete CoreBluetooth driver now owns Apple delegate state on one serial
queue, while an actor host merges system-connected peripherals, deduplicates
scan results, serializes operations per peripheral, and preempts background
reconnect for manual selection. Native host services now atomically persist
non-secret workflow journals, isolate secrets in Keychain, keep recording and
firmware bytes in bounded files, resolve application material by opaque ID, and
stream URLSession progress without exposing paths or credentials to Rust. The
public `BotaDeviceClient` now configures those hosts once and exposes
serial-verified discovery, manual connection, canonical reconnect, explicit
disconnect, connection observation, and decoded device-status streams. Client
destruction cancels active work, stops status subscriptions, disconnects the
verified peripheral, and closes observers. Public secure-lifecycle managers now
resolve provisioning and command-bound reset material through application
callbacks, normalize Bota Note connection settings, keep remove-only
deprovision separate from destructive reset, and resume only an exact durable
reset result for the current binding generation. Public recording, upload
ownership, OTA, and device-log managers now expose typed async streams while
keeping recording and firmware bytes in native files and accepting only opaque
application-supplied upload identifiers. The Apple package is not yet published.
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
npm run sync:apple-fixtures
npm run test:fixtures
npm run test:workflows -- --sdk-path ../react-native-sdk
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
cargo xtask protocol generate --check
tools/ffi-smoke/run-native-c-smoke.sh
tools/ffi-smoke/run-native-swift-smoke.sh
tools/apple/test-package.sh
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
