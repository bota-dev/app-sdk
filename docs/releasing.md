# Releasing The Bota App SDK

Published synchronized beta `1.1.0` includes the Apple `BotaAppleSDK` Swift
package for iOS 15+ and macOS 13+, the Android Maven package, and the React
Native package. `1.2.0-beta.0` is occupied by an immutable annotated tag for
non-Flutter source; it must not be reused for the prepared Flutter facade. The
unpublished `v1.2.0-beta.1` and `v1.2.0-beta.2` tags are also immutable and
must not be moved after their release workflows failed. Beta.2 stopped at the
candidate-inventory projection before signing or publishing any artifact;
its package bytes matched the main-CI inventory. `1.2.0-beta.11` is the selected
replacement candidate. Its Web foreground implementation and automated Chromium/package
gates are complete; supervised Web physical-device acceptance remains open.
The beta.3 Central deployment reached `PUBLISHED`, but the tagged release
workflow stopped before npm and Apple publication because Central did not serve
the HTML version-directory index within its ten-minute verification window.
All 30 expected public Maven files were independently verified against the
signed inventory. A same-tag retry after the index appeared failed closed
because PGP signing produced different bytes from the archived Central bundle.
The beta.3 tag remains immutable. Beta.4 uses the corrected file-based verifier
and restores preserved signed inputs before signing on a same-tag retry.
The immutable beta.4 tag passed main CI, but its tagged Android packaging job
failed twice in a START-reply test fixture before any registry write. Its
protected publish job was skipped. Beta.5 synchronizes the corrected test
fixture; do not move or reuse beta.4.
Beta.5 also passed main CI, but the tagged Android unit-test step stalled and
the run was cancelled before publication. Beta.6 uses a per-subscription test
barrier and bounded cleanup. The tagged Android packaging step also has a
15-minute timeout to fail before publication on any future stall. Do not move
or reuse beta.5.
Beta.6 passed main CI but failed a tagged START-dependent Android unit test
before publication. The test class mixed virtual `runTest` time with real IO;
beta.7 uses `runBlocking` for that integration fixture. Do not move or reuse
beta.6.
Beta.7 published Apple SwiftPM, Android Maven, React Native npm, and Web npm,
but CocoaPods Trunk rejected the first `BotaAppleSDK` pod after local iOS/macOS
validation. The tagged podspec used `prepare_command`, which Trunk does not
allow for a new pod. Flutter and synchronized completion were held. Do not move
or reuse beta.7. Beta.8 distributed a checksummed CocoaPods archive containing
the same Swift facade sources and XCFramework without install-time scripting.
Apple SwiftPM, CocoaPods, Android Maven, React Native npm, and Web npm are
public at beta.8, but its pod workflow failed after Trunk registered the pod:
the CDN-backed `pod spec cat` lookup missed the new registration and a retry
attempted a duplicate push. Flutter was held. Do not move or reuse beta.8.
Beta.9 checks the authoritative Trunk API before pushing and after any uncertain
push result, so a delayed CDN index cannot cause a duplicate submission.
Beta.9 published Apple SwiftPM, CocoaPods, Android Maven, React Native npm, and
Web npm, and all public consumers passed. Flutter was nevertheless skipped:
GitHub propagated the deliberately skipped Central recovery job through the
release dependency graph. Do not move or reuse beta.9. Beta.10 corrected the
Flutter-side job conditions and published the native and npm artifacts, but the
Flutter candidate job failed because its consumer gate could not locate the
installed CocoaPods 1.16.2 executable. Do not move or reuse beta.10. Beta.11
passes the installed executable explicitly to that gate.
Apple consumers add
`https://github.com/bota-dev/app-sdk.git` in Xcode. The root `Package.swift`
compiles the Swift facade source and downloads a checksummed
`BotaDeviceSDKCore.xcframework.zip` from the matching GitHub Release.

The nested `platforms/apple/Package.swift` remains the local-development
package. It points at the generated XCFramework on disk so facade tests do not
depend on a published release.

The Flutter `bota_flutter_sdk` facade is implemented and locally gated for iOS
15+ and Android API 26+, but it was not published with synchronized version
`1.1.0` or the occupied `1.2.0-beta.0` identity. Do not advertise or attempt to
recover either nonexistent Flutter artifact.

The Android package uses Maven coordinate `dev.bota:bota-android-sdk`. The
synchronized `1.1.0` beta release publishes it through the protected Central
Portal workflow after deterministic packaging and native acceptance gates pass.

All artifacts use the exact version in `sdk-version.toml`. Release tags use
`vVERSION`; the tag, package metadata, public Swift version, compatibility
matrix, release example, GitHub Release URL, and XCFramework checksum must
agree. The Apple workflow does not publish the Rust core or FFI crates to
crates.io.

The synchronized line is beta. New versions must match `1.x.y-beta.n`, npm
publication must use dist-tag `beta`, and GitHub Releases remain prereleases.
SwiftPM and Maven Central consumers pin the exact synchronized beta version.
Historical immutable `1.1.0` is the one recovery exception; do not rename,
unpublish, or recreate it. The next synchronized release is selected as
`1.2.0-beta.11`; do not move, delete, recreate, or reuse `v1.2.0-beta.0`
through `v1.2.0-beta.10`.
Before that first Web publication, configure the npm trusted publisher for
`@bota.dev/web-sdk` against the protected `release` environment and this
repository's release workflow. The workflow intentionally has no token-based
fallback.

## Repository Setup

Create a GitHub environment named `release` for `bota-dev/app-sdk`:

1. Require a reviewer before deployment.
2. Restrict deployment branches and tags to protected release tags.
3. Add only `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`,
   `SIGNING_IN_MEMORY_KEY`, `SIGNING_IN_MEMORY_KEY_PASSWORD`, and
   `COCOAPODS_TRUNK_TOKEN` as environment secrets. Do not add a crates.io or
   pub.dev token; Flutter's later automated publications use OIDC.

The environment approval is the human boundary for release authorization and
external hardware acceptance. Automated tests never claim a physical-device
result. Keep supervised device evidence separate and follow
[`docs/testing/apple-physical-device.md`](testing/apple-physical-device.md) when
new hardware or firmware requires another lab run.

For the Web facade, follow
[`docs/testing/web-physical-device.md`](testing/web-physical-device.md) in a
supported desktop Chromium browser. The reviewer must confirm every required
row against one exact Bota device and the exact candidate source revision.
`npm run web:verify` uses deterministic fake Bluetooth and is not a substitute.
Ordinarily, do not approve the protected release environment while a required
Web row is `NOT RUN` or failed. For `1.2.0-beta.7` and its CocoaPods repairs
`1.2.0-beta.8`, `1.2.0-beta.9`, `1.2.0-beta.10`, and `1.2.0-beta.11`, the release owner explicitly requested a public beta rollout
before supervised production-device testing. This authorizes publication for
that post-release test, not a claim
of Web hardware acceptance or general availability. A failed automated gate
still blocks publication, and any failed supervised row must be triaged before
another version is released. The open hardware status is recorded in
[`release/evidence/1.2.0-beta.11-web-foreground.md`](../release/evidence/1.2.0-beta.11-web-foreground.md).

## Prepare A Version

Start from a clean `main` branch. Update every synchronized version authority
and commit that version bump before calculating the Apple checksum.

While the beta policy is active, select a new `1.x.y-beta.n` version that is not
already occupied. Update every version authority and the matching
`release/examples/VERSION.json` together. The release-channel resolver rejects
a new stable tag before any publication work starts.

The React Native Codegen contract includes the package version in its digest.
After a version bump, regenerate and review it before committing:

```bash
npm run codegen --prefix frameworks/react-native
npm run codegen:check --prefix frameworks/react-native
```

Generate deterministic SwiftPM and CocoaPods archives and write their matching
root manifests:

```bash
tools/apple/package-release.sh --write-package-manifest
swift package dump-package
git diff -- Package.swift platforms/apple/BotaAppleSDK.podspec
```

The explicit preparation mode builds from the current working snapshot,
computes its SwiftPM and CocoaPods checksums, and changes only the two public
package manifests; this permits a
synchronized version change and its generated checksums to land in one commit.
Review and commit both manifests. The CocoaPods source is a checksummed
`BotaAppleSDK.cocoapods.zip` containing Swift sources and the generated
XCFramework; it must not use `prepare_command`, which Trunk rejects for new
pods. Then rerun the normal check-only mode from the
new clean commit:

```bash
tools/apple/package-release.sh
```

Normal mode fails if rebuilding the XCFramework produces a checksum different
from the committed root package. Never hand-edit the release URL or checksum.

PR and main CI use `tools/apple/package-release.sh --evidence-only` to generate
and validate unpublished evidence for the current commit without comparing it
to the immutable package from the previous release. This mode is not used by
the protected release workflow; tagged releases always use normal mode and its
exact root-package checksum check.

## Local Release Gate

Use Node.js 22 or newer and the Rust toolchain pinned by the repository:

CI checks out the pinned maintenance React Native workflow baseline below
`.ci/`. Do not move that checkout below Cargo's `target/`; the Rust cache action
may recursively clean that directory before the baseline dependency install.

Before the local Web gate, install only the Playwright 1.63.0 Chromium build
into the repository target directory. `web:verify` then creates one
`target/web-release` tarball and inventory, installs only that tarball into the
Vite consumer, and runs its production build and browser cases. The release
workflow publishes this verified payload unchanged.

```bash
npm ci
npx --yes npm@12.0.2 ci --prefix tests/consumers/web-vite
PLAYWRIGHT_BROWSERS_PATH="$PWD/target/playwright-browsers" \
  tests/consumers/web-vite/node_modules/.bin/playwright install chromium
npm run check
npm run test:tooling
npm run test:release
npm run web:verify
npm run sync:apple-fixtures
npm run test:workflows -- --sdk-path ../react-native-sdk
cargo xtask release verify-tag "v$(sed -n 's/^version = "\([^"]*\)"$/\1/p' sdk-version.toml)"
cargo xtask protocol generate --check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
tools/ffi-smoke/run-native-c-smoke.sh
tools/ffi-smoke/run-native-swift-smoke.sh
tools/apple/test-package.sh
tools/apple/test-consumer.sh
tools/apple/package-release.sh
tools/apple/test-pod-archive.sh
tools/flutter/run-flutter.sh test frameworks/flutter/bota_flutter_sdk/test
tools/flutter/test-android-adapter.sh
tools/flutter/test-consumers.sh
npm run flutter:verify
# Automatic CI-equivalent verification; beta.1 preserves a release candidate.
tools/flutter/package-release.sh --ci
# Strict local release gate for selected beta.1; occupied beta.0 still refuses.
tools/flutter/package-release.sh --check
node --test tools/flutter/verify-publication.test.mjs tools/release/*.test.mjs
cargo deny check
```

## Android Package Gate

Android release checks require JDK 17, Android SDK 36, NDK 28.2.13676358,
Node.js 22+, OpenSSL, and GnuPG. The check-only package command requires a clean
HEAD and writes only below `target/`:

```bash
tools/android/test-publication-graphs.sh
tools/android/package-release.sh --check
tools/android/verify-publication.sh target/android-release
cargo xtask release validate target/android-release/release-manifest.json
tools/android/install-release-repository.sh target/android-release target/android-m2
tools/android/test-legacy-consumer.sh --mode source --compile-only --repository target/android-m2
tools/android/test-legacy-consumer.sh --mode binary --compile-only --repository target/android-m2
tools/android/test-consumer.sh --compile-only --repository target/android-m2
```

`package-release.sh --check` performs two clean builds and rejects any AAR or
per-ABI native-library digest drift. It invokes only the unsigned local Maven
publication, proves that no signing task or `.asc` file is present, and emits
the AAR, POM, Gradle module metadata, sources, Dokka Javadoc, four checksum
formats for every Maven primary, copied MIT license, SPDX 2.3 SBOM, and native
manifest version 2. The host-side consumer compile commands catch source and
binary fixture drift before either emulator lane starts.

The published runtime dependency set is reviewed in
`protocol/baseline/android-maven-license-policy.json`. The package command and
license workflow require every Gradle module dependency to have an exact
coordinate, version, approved license, and reviewer in that policy, and require
the SPDX declaration to match. Unreviewed Maven dependencies fail closed.

The API compatibility lanes consume the reconstructed repository rather than
republishing from source:

```bash
tools/android/test-emulator-lane.sh --api 26
tools/android/test-emulator-lane.sh --api 35
```

The exact x86/x86_64 images run on Ubuntu release CI. Apple Silicon cannot run
the required API 26 x86 image, so a local arm64 emulator is not equivalent
release evidence. Each lane exports a fresh, lane-local `ANDROID_AVD_HOME` so
`avdmanager` and the emulator resolve the same AVD. ADB attachment is bounded;
an emulator that exits or never registers fails with the ADB device list and
captured emulator output instead of leaving the release job blocked.

The separate publication-graph test creates a password-protected ephemeral PGP
key in a mode-0700 temporary keyring. It proves that protected staging cannot
start without both in-memory key properties, then verifies all five detached
signatures. Gradle's exact 55-file raw repository is normalized to the 30-file
Central Portal tree. The generated ZIP contains only the path-sorted Portal
inventory, with mode 0644 and the fixed 1980 DOS timestamp; the inventory stays
beside the ZIP rather than inside it.

Protected automation sets only these environment-backed Gradle properties:

```text
ORG_GRADLE_PROJECT_signingInMemoryKey
ORG_GRADLE_PROJECT_signingInMemoryKeyPassword
ORG_GRADLE_PROJECT_signingInMemoryKeyId  # optional
```

The protected command must include the exact opt-in
`-PbotaProtectedSigning=true`. Any other value fails configuration. Never put
the key, password, or key ID in command arguments, tracked files, build scans,
logs, or uploaded artifacts.

`tools/apple/package-release.sh` writes the release payload to
`target/apple-release/`:

- `BotaDeviceSDKCore.xcframework.zip`
- `BotaDeviceSDKCore.xcframework.zip.sha256`
- `BotaDeviceSDKCore.xcframework.swiftpm-checksum`
- `BotaAppleSDK.spdx.json`
- `LICENSE`
- `release-manifest.json`

Future Apple packaging emits release manifest version 2 with
`sdkFamily: "bota-app-sdk"` and artifact fields `platform: "apple"` and
`packageIdentifier: "BotaAppleSDK"`. The public JSON Schema and Rust validator
require every version 2 platform/package identifier to be one exact pair from
the public package matrix; independently valid platform and package values
cannot be mixed.

The public `v1.0.0` manifest is an immutable version 1 document. Historical
evidence uses `validate_manifest_format_and_semantics`, which validates its own
SDK/artifact version consistency, checksums, firmware range, capabilities, and
v1/v2 rules without consulting the current checkout version. Normal
`validate_manifest` calls and `cargo xtask release validate` additionally
require `sdkVersion` to equal the current `sdk-version.toml`; release candidate
validation must always use that strict path.

The packaging log includes SHA-256 digests for every normalized XCFramework
input and for the final archive. Use those values to identify toolchain-specific
output before changing the checksum pinned in `Package.swift`.
Rust compilation remaps the checkout and Cargo registry paths, and packaging
fails if either original machine-specific prefix remains in a static library.

The XCFramework contains arm64 iOS, arm64/x86_64 iOS Simulator, and
arm64/x86_64 macOS slices.

## Flutter Package Gate

Flutter verification must use the repository wrapper, which pins Flutter
3.47.2 and Dart 3.13.2. The package version and its packaged Android
`sdk-version.toml` must equal the root version, generated Pigeon Dart, Swift,
and Kotlin outputs must be byte-identical, and analysis plus all Dart tests must
pass.

`tools/flutter/test-consumers.sh` is the pre-publication mobile build gate. It
must:

1. Reject missing or empty iOS Bluetooth usage descriptions and incomplete
   Android API 26-35 Bluetooth permissions.
2. Rebuild the local Apple XCFramework and Android Maven candidate after
   removing the prior exact-version Android directory.
3. Generate a complete disposable Flutter iOS/Android application and use an
   isolated Gradle home.
4. Resolve `BotaAppleSDK` from the exact local package and reserve the
   `dev.bota` group for the exact local Android repository.
5. Produce a new Android release APK and unsigned iOS release application.

The maintained `example/` directory intentionally contains only application
source, package metadata, and permission manifests. Generated runner files are
never release evidence by themselves. A consumer failure must not fall back to
an earlier application build, cached native candidate, remote Maven artifact,
or remote Apple package.

The first Flutter beta may be published only after every `1.2.0-beta.11` version
authority changes together and the Apple
and Android artifacts at that exact version are public with passing no-override
consumers. The initial pub.dev publication mechanism must be deliberately
authorized for that selected version; the workflow no longer prints a beta.0
publish command. Later prereleases use pub.dev's GitHub OIDC workflow. Every
publication is downloaded and compared with the candidate's exact file hashes
and normalized archive SHA-256 before release completion.

`tools/flutter/package-release.sh --check` refuses occupied
`1.2.0-beta.0`. For selected `1.2.0-beta.11`, it writes
only deterministic evidence to `target/flutter-release/`: the candidate
archive, exact package inventory, v2 release manifest, dependency lock and
graph, hosted-package license hashes, normalized dry-run output, and fixed
verification record. It rejects unsafe or hidden paths, links, credentials,
generated/build outputs, local Apple overrides, unreviewed extras, and raw,
normalized, or per-file checksum drift.
The checked release example freezes the tooling-generated preparation
revision; check mode permits only that revision field to differ from a runtime
candidate, which always records the current Git revision. Do not hand-edit a
source revision, archive checksum, file inventory, or root Swift checksum.

Automatic PR/main CI uses `tools/flutter/package-release.sh --ci`. That mode
runs the same analysis, tests, license audit, publication dry run, and fresh
Android/iOS consumer builds. For occupied beta.0 it reports
`candidate-ready=false`, removes any stale Flutter candidate directory, and
succeeds without creating release bytes. For beta.1 and later synchronized
versions it reports `candidate-ready=true` and creates the same deterministic
candidate as check mode.

## Publish

Before tagging, configure npm trusted publishers for both
`@bota.dev/react-native-sdk` and `@bota.dev/web-sdk` with organization
`bota-dev`, repository `app-sdk`, workflow `release.yml`, environment
`release`, and allowed action `npm publish`. Each package has one trusted
publisher. Replace the legacy React Native repository publisher instead of
retaining both. The Web package's first publication must also use this
protected workflow; do not bootstrap it from a developer token.

This workflow owns npm `beta`; the legacy React Native repository owns npm
`latest`. Every npm publication command includes `--tag beta`, verifies the
candidate `dist.shasum`, and proves that `latest` is unchanged.

After the release commit is on `main`, wait for its `CI` workflow to complete.
The `Release candidate inventory` job downloads the Apple, Android, React
Native, Web, and, when `candidate-ready=true`, Flutter artifacts built on the
same runner classes as the tag workflow and uploads
`release-candidate-<commit>`. An inventory without Flutter is transitional
verification evidence for occupied beta.0 and must not be tagged. Use a
five-platform artifact's
`release-candidate-files.json.sha256` value in the annotated tag; do not derive
the tag hash from locally built payloads. The Android Javadoc archive omits
Dokka's nondeterministic aggregate `deprecated.html` page so repeated clean CI
builders produce the same inventory.

```bash
VERSION=$(sed -n 's/^version = "\([^"]*\)"$/\1/p' sdk-version.toml)
SOURCE_REVISION=$(git rev-parse HEAD)
CANDIDATE_INVENTORY_SHA256=$(awk '{print $1}' \
  /path/to/release-candidate-files.json.sha256)
git tag -a "v$VERSION" \
  -m "Bota App SDK $VERSION" \
  -m "Source-Revision: $SOURCE_REVISION" \
  -m "Candidate-Inventory-SHA256: $CANDIDATE_INVENTORY_SHA256"
cargo xtask release verify-tag "v$VERSION"
git push origin "v$VERSION"
```

Before tagging, verify the downloaded JSON records `SOURCE_REVISION` and the
CI workflow succeeded for that exact commit. Local package commands remain
useful preflight checks, but their output is not release identity.
The CI React Native candidate job installs both root repository tooling and the
package workspace because compatibility tests import the root API-contract
parser.

The tag workflow:

The `verify` and `apple` jobs use independent clean checkouts. Each job must
install its own Node.js dependencies before running repository tooling.

1. Verifies synchronized metadata and that the tagged commit belongs to
   `origin/main`.
2. Runs the Rust, tooling, ABI, license, Apple package, and local-consumer gates.
3. Packages Android once, runs API 26 and API 35 consumers against that exact
   AAR, and uploads the unsigned Maven publication inputs.
4. Rebuilds the deterministic XCFramework and CocoaPods source archive,
   rejects checked-in checksum drift, and lints the exact extracted pod archive
   for iOS and macOS before publication.
5. Waits for approval in the protected `release` environment.
   Public Maven verification requires all 30 expected file URLs and hashes.
   It also checks the HTML directory listing for missing or extra entries when
   Central serves one, but does not require that optional index to exist.
6. Publishes the exact React Native and Web npm tarballs to dist-tag `beta`
   through OIDC trusted publishing, verifies both registry `dist.shasum`
   values, and proves npm `latest` did not move. The Web first-publication path
   accepts an absent pre-release `latest` tag. A rerun verifies an existing
   version instead of attempting to replace it.
7. Creates a GitHub prerelease and uploads every public Apple release file plus
   the React Native and Web tarballs. The Android payload remains an immutable
   workflow artifact downloaded inside the protected job; its flat filenames
   intentionally are not mixed with Apple's colliding `LICENSE` and manifest
   assets.
8. Publishes or verifies the exact `BotaAppleSDK` CocoaPod through a protected
   reusable workflow, then creates unrelated no-override SwiftPM and CocoaPods
   consumers. The SwiftPM smoke compiles an executable importing only
   `BotaAppleSDK`. It deliberately
   does not launch a Bluetooth-capable process on the headless runner. It uses
   one non-batched Swift compiler job to keep memory bounded.
9. Rebuilds the exact Flutter candidate only after the public Apple and Android
   consumers pass and compares it to the Flutter subset of the CI inventory
   named in the annotated tag.
10. Refuses the occupied `1.2.0-beta.0` identity. For selected
    `1.2.0-beta.11`, its explicitly authorized first-publish
    procedure must consume the ordered candidate artifact; later beta tags use
    Dart's official reusable OIDC publisher.
11. Downloads the public pub.dev archive, compares its complete normalized
    inventory and file hashes, preserves public evidence, and only then attaches
    Flutter artifacts as the completed synchronized prerelease evidence.

Main CI must not resolve the candidate version through the public root package:
its binary URL is created by this workflow. React Native lifecycle tests use
`platforms/apple` and its locally built XCFramework; step 7 is the authoritative
post-publication remote-resolution gate.

The protected workflow stages the signed raw Maven repository with in-memory
PGP material, normalizes it to the exact 30-file Portal tree, and persists the
bundle, inventory, and `central-portal-state.json` on a draft GitHub Release
before upload. The initial HTTP 201 deployment UUID is fsynced before polling.
An uncertain upload outcome stops automatic retries; use the protected
`workflow_dispatch` recovery with the exact `refs/tags/v<version>`, the Portal
UUID, the original tag workflow `releaseRunId`, and
`centralRecoveryMode=resume-uncertain`. That mode downloads the preserved bytes
and never rebuilds, re-signs, or re-uploads them.

Detached PGP signatures include their creation time, so rerunning the tag job
first checks the draft release. If all four preserved inputs exist, it verifies
the archived candidate, signed ZIP, state hashes, coordinate, source revision,
and tagged AAR, then skips signing and resumes from those exact bytes. An
incomplete archive fails closed. It must not replace the preserved Central ZIP
with newly signed bytes. If Central
returns a confirmed `FAILED` deployment, first fix the reported external
validation cause, then dispatch `centralRecoveryMode=retry-failed` with that
failed UUID. The protected job verifies the old deployment is `FAILED` and has
the preserved deployment name, recreates `READY` state from the archived ZIP
and inventory, and uploads those exact bytes as a fresh deployment. The new
state records `retryOfDeploymentId` for auditability.

Both recovery modes download the original run's Apple, Android, React Native,
and Web artifacts and compare their non-Flutter subset with the five-platform
candidate inventory preserved on the draft release. They never rebuild or
publish Flutter. After Central and its public inventory pass, the recovery job
publishes or verifies both exact npm tarballs under
`beta`, leaves `latest` unchanged, publishes the existing GitHub prerelease
assets, and enables the same public SwiftPM plus API 26/API 35 Maven consumer
jobs as the tag workflow. Recovery resolves metadata from the requested tag;
new release mode rejects stable tags while historical `v1.1.0` recovery remains
available.

Rerunning an occupied Flutter version does not invoke an interactive or OIDC
publish command. It downloads the preserved candidate and the existing public
archive, verifies them, and resumes release completion only when every byte-level
inventory contract passes.

Central states resume as follows: `PENDING` and `VALIDATING` poll,
`VALIDATED` publishes once, `PUBLISHING` polls, `PUBLISHED` verifies the public
repository, and `FAILED` stops with sanitized errors. A missing public POM is
not evidence that another upload is safe; only the explicit failed-deployment
path may create a replacement upload. After `PUBLISHED`, every public
Maven file must match the signed inventory before the API 26 and API 35 public
consumer lanes run.

Do not move or recreate a published tag. If a released artifact or manifest is
wrong, fix the source and publish a new patch version with a new checksum.

## Consumer Requirements

iOS applications must include `NSBluetoothAlwaysUsageDescription`. Sandboxed
macOS applications must enable **App Sandbox > Hardware > Bluetooth**, which
sets `com.apple.security.device.bluetooth`; macOS applications should also
provide the Bluetooth usage description displayed to users.

The package contains no Bota backend API client. Host applications remain
responsible for backend grants, device tokens, and presigned upload targets.
