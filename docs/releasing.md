# Releasing The Bota Device SDK

All artifacts use the exact version in `sdk-version.toml`. The first public
artifact is the `bota-device-sdk-core` crate; platform SDKs are not published
from this workflow.

## First crates.io Release

crates.io requires an API token for a crate's initial publication. Trusted
Publishing can be configured only after the crate exists.

Before pushing `v1.0.0`:

1. Create a GitHub environment named `release` for `bota-dev/app-sdk`.
2. Restrict the environment to protected release tags and require a reviewer.
3. Create a short-lived crates.io API token allowed to publish a new crate.
4. Store it as the `CRATES_IO_TOKEN` secret in the `release` environment.
5. Verify `cargo xtask release verify-tag v1.0.0` and the full local gate.
6. Create and push the exact `v1.0.0` tag from the reviewed release commit.

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
cargo xtask release verify-tag v1.0.0
cargo xtask protocol generate --check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo deny check
cargo package --locked --package bota-device-sdk-core
cargo publish --locked --package bota-device-sdk-core --dry-run
```

Do not create a release tag when the environment secret or protection rules are
missing. Do not publish the `xtask` package or any unfinished platform facade.
