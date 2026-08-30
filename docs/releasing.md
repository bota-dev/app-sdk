# Releasing The Bota Device SDK

All artifacts use the exact version in `sdk-version.toml`. The first public
artifact is the `bota-device-sdk-core` crate; platform SDKs are not published
from this workflow.

The typed native ABI is frozen and tested as source in
`bindings/device-sdk-ffi`, but the local static library is not a distributable
Apple or Android package. Do not publish or attach it as a platform artifact.
Apple publication begins only after the XCFramework, Swift package import,
fake-host, and physical-device gates in the Apple facade plan pass; Android has
equivalent AAR and device gates in its later plan.

Every change to the Apple facade must pass `tools/apple/test-package.sh` and
`tools/apple/test-consumer.sh`, plus generic iOS device and simulator builds
with code signing disabled. From a clean source tree,
`tools/apple/package-release.sh` rebuilds and deterministically archives the
XCFramework, copies `LICENSE`, emits SHA-256 and SwiftPM checksums, generates an
SPDX 2.3 document from locked Cargo and Swift package metadata, and validates a
SwiftPM artifact entry against the release schema. It rejects Node versions
older than 22, a dirty tree, zero or inconsistent checksums, version drift, and
local checkout paths in the SBOM.

The generated files live under `target/apple-release/`. CI uploads that
directory as non-published evidence. Those files are not release assets and do
not make the Apple package publishable; physical-device acceptance remains a
separate gate. The manifest claims only capabilities marked `supported` in the
firmware compatibility matrix. A public Apple release must regenerate the same
metadata from its exact clean release commit.

Stable `v1.0.0` is reserved for the first release that Demo and Bota One can
consume through the React Native compatibility package. Protocol and workflow
core milestones publish as `1.0.0-alpha.N`.

## First crates.io Prerelease

crates.io requires an API token for a crate's initial publication. Trusted
Publishing can be configured only after the crate exists.

Before pushing `v1.0.0-alpha.1`:

1. Create a GitHub environment named `release` for `bota-dev/app-sdk`.
2. Restrict the environment to protected release tags and require a reviewer.
3. Create a short-lived crates.io API token allowed to publish a new crate.
4. Store it as the `CRATES_IO_TOKEN` secret in the `release` environment.
5. Verify `cargo xtask release verify-tag v1.0.0-alpha.1` and the full local gate.
6. Create and push the exact `v1.0.0-alpha.1` tag from the reviewed release
   commit.

The tag workflow tests and packages the crate, runs `cargo publish --dry-run`,
generates a release manifest containing the source revision and crate checksum,
publishes to crates.io, and attaches the crate plus manifest to the GitHub
release. It is safe to rerun after publication.

## After The Bootstrap Release

Immediately configure crates.io Trusted Publishing with:

- Owner: `bota-dev`
- Repository: `app-sdk`
- Workflow: `release.yml`
- Environment: `release`

Then replace the API-token step with the pinned
`rust-lang/crates-io-auth-action`, remove the GitHub secret, and revoke the
bootstrap crates.io token. Future releases must use the short-lived OIDC token.

## Release Gate

```bash
cargo xtask release verify-tag v1.0.0-alpha.1
cargo xtask protocol generate --check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
tools/ffi-smoke/run-native-c-smoke.sh
tools/ffi-smoke/run-native-swift-smoke.sh
tools/apple/test-package.sh
tools/apple/test-consumer.sh
node --test tools/release/generate-apple-*.test.mjs
tools/apple/package-release.sh
cargo deny check
cargo package --locked --package bota-device-sdk-core
cargo publish --locked --package bota-device-sdk-core --dry-run
```

Do not create a release tag when the environment secret or protection rules are
missing. Do not publish the `xtask` package, `bota-device-sdk-ffi` by itself, or
any unfinished platform facade. Native ABI evidence is recorded separately in
`release/evidence/1.0.0-alpha.1-native-abi.md`.
