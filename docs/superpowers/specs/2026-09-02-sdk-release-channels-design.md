# Bota SDK Release Channels Design

**Status:** Approved; implementation pending

## Decision

The existing React Native SDK remains the stable maintenance line while the
synchronized Bota App SDK is evaluated as a beta:

| Line | Source repository | Version form | npm tag | Audience |
|---|---|---|---|---|
| React Native maintenance | `bota-dev/react-native-sdk` | `0.0.x` | `latest` | Existing production consumers |
| Synchronized App SDK | `bota-dev/app-sdk` | `1.x.y-beta.n` | `beta` | Explicit beta consumers |

The Apple, Android, and React Native App SDK facades continue to share one
version. Calling the App SDK beta does not permit platform versions to drift.

## Current 1.1.0 Release

Published package versions are immutable and are not renamed or unpublished.
The already-published `1.1.0` artifacts are reclassified operationally:

- npm `latest` points to `0.0.65`.
- npm `beta` points to `1.1.0`.
- GitHub release `v1.1.0` is marked as a prerelease.
- Maven Central `dev.bota:bota-android-sdk:1.1.0` and SwiftPM tag `v1.1.0`
  remain available and must be installed by exact version during the beta.

The next synchronized App SDK release is `1.2.0-beta.0`. A prerelease must not
be created for the already-finalized `1.1.0` tuple because that would move
semantic-version precedence backward.

Demo and Bota One may continue pinning exact App SDK version `1.1.0` as beta
acceptance consumers. Reclassifying npm tags does not change their lockfiles or
installed native artifacts.

## Consumer Contract

During the migration period:

```bash
# Existing production implementation
npm install @bota.dev/react-native-sdk

# Synchronized App SDK beta
npm install @bota.dev/react-native-sdk@beta
```

Documentation must not tell general React Native consumers to install an
untagged App SDK version while `latest` is owned by the maintenance line.
Apple and Android beta documentation uses an exact prerelease version because
SwiftPM and Maven Central do not provide npm-style distribution tags.

## Publishing Authority

npm permits one trusted publisher per package and requires the package
`repository.url` to match that publisher's repository. The trusted publisher
for `@bota.dev/react-native-sdk` remains:

- Organization: `bota-dev`
- Repository: `app-sdk`
- Workflow: `release.yml`
- Environment: `release`

The App SDK release workflow publishes only App SDK candidates. It must not
check out the legacy repository and publish its tarball, because doing so would
misrepresent the package source and provenance.

No long-lived npm write token is added to either repository. No release process
temporarily switches the trusted publisher between repositories.

## App SDK Beta Publication

The App SDK release tooling derives the candidate version from
`sdk-version.toml` and the exact annotated tag. While this channel policy is
active, a new release must contain a SemVer prerelease component and the
following behavior is enforced:

1. Apple, Android, React Native, manifests, release assets, and evidence use the
   same exact prerelease version.
2. npm publishes with `--tag beta`; a beta workflow never writes `latest`.
3. GitHub creates or edits the release with prerelease status enabled.
4. Maven Central publishes the exact prerelease coordinate.
5. SwiftPM uses the exact prerelease tag and checksum-matched release asset.
6. Recovery verifies existing bytes before accepting an already-published
   artifact, exactly as stable publication does.

Hard-coded `1.1.0` paths, coordinates, recovery inputs, and concurrency keys in
the release workflow are replaced with the verified candidate version. Tests
must reject a bare npm publish command and a stable App SDK version while beta
policy is active.

## Legacy 0.0.x Publication

The legacy repository remains the source of truth for `0.0.x`. Its release
workflow becomes a candidate builder, not an npm publisher:

1. Require an exact `v0.0.x` tag whose version matches `package.json`.
2. Install from the lockfile, then run type checking, tests, build, and the
   dependency-license gate.
3. Pack with a pinned npm CLI.
4. Record the tarball filename, package name, version, source revision, SHA-1,
   and SHA-256 in a machine-readable candidate inventory.
5. Upload the tarball and inventory as immutable workflow artifacts.
6. Never run `npm publish` in repository automation.

An authorized maintainer downloads that exact candidate and publishes it from
an interactive npm session protected by WebAuthn:

```bash
npm publish ./bota.dev-react-native-sdk-0.0.x.tgz \
  --access public \
  --tag latest
```

The completion check requires the registry `dist.shasum` to equal the
candidate SHA-1 and requires `latest` to equal the new `0.0.x` version. If the
version already exists with the same hash, publication is treated as complete;
a different hash is a hard failure. The App SDK `beta` tag must remain
unchanged throughout maintenance publication.

Manual publication intentionally has no OIDC provenance. This is accepted only
for the temporary maintenance line and is preferable to a stored write token,
publisher switching, or incorrect repository metadata.

## Promotion To Stable

The App SDK may take ownership of npm `latest` only through an explicit future
decision that retires the `0.0.x` maintenance line. That promotion requires:

- the synchronized version no longer carries a prerelease component;
- migration and physical-device release gates pass;
- public installation docs switch from `@beta` to the untagged package;
- npm `latest` moves to the synchronized release;
- the manual legacy publication runbook is retired; and
- the channel-policy tests are updated in the same reviewed change.

Publishing a stable App SDK version alone must not implicitly perform this
promotion.

## Failure And Recovery

- npm dist-tags are mutable control-plane pointers; package versions and Maven
  artifacts remain immutable.
- A mistaken tag move is repaired by restoring `latest` and `beta`; no version
  is unpublished.
- A failed App SDK beta publication uses the existing checksum-bound recovery
  workflow and exact Central deployment state.
- A failed legacy publication is retried only with the original verified
  tarball. Repacking after tagging creates a new candidate and requires a new
  review.
- Registry verification checks both tags after every publication so one line
  cannot silently displace the other.

## Verification

Implementation is complete only when automated tests prove:

- App SDK prerelease parsing and synchronized version propagation;
- npm beta publication cannot mutate `latest`;
- GitHub prerelease creation and recovery behavior;
- removal of release-workflow `1.1.0` hard-coding;
- legacy `v0.0.x` tag and package-version validation;
- deterministic legacy tarball and candidate inventory generation;
- absence of automated legacy `npm publish` and stored npm write tokens; and
- post-publication verification of exact registry hashes and both dist-tags.

The external migration check verifies that `latest` resolves to `0.0.65`,
`beta` resolves to `1.1.0`, and existing exact-version Demo and Bota One
installs remain unchanged.

## References

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm distribution tags](https://docs.npmjs.com/adding-dist-tags-to-packages/)
- [npm semantic-version prereleases](https://docs.npmjs.com/cli/v6/using-npm/semver/)
