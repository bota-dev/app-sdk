# App SDK Package Naming Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the five approved App SDK package identities in one synchronized major beta without altering historical releases or the RN maintenance line.

**Architecture:** Keep the runtime, native bridge identities, and protocol unchanged. Make release identity version-aware, then update the coupled platform distributions and their consumers together. Preserve historical recovery before switching current packaging and publication to the new names.

**Tech Stack:** Rust/serde/semver, SwiftPM/CocoaPods, Kotlin/Gradle/Maven, React Native/TypeScript/npm, WebAssembly, Flutter/Dart/Pigeon, GitHub Actions.

**Spec:** [Approved naming migration](../specs/2026-09-23-app-sdk-package-naming-migration-design.md).

**Status:** Prepared for review; no implementation tasks completed.

## Global Constraints

- Keep the repository `app-sdk` and family **Bota App SDK**. Documentation uses **Bota App SDK for <platform>**.
- Use `BotaAppSDK`, `dev.bota:bota-app-sdk`, `@bota.dev/react-native-app-sdk`, `@bota.dev/web-app-sdk`, and `bota_app_sdk`.
- Select synchronized `2.0.0-beta.0` only after checking that identity is unoccupied. Keep versions synchronized through `sdk-version.toml`.
- Preserve every published version, Git tag, release asset, checksum, and old npm dist-tag, including maintenance `@bota.dev/react-native-sdk@0.0.x` and its `latest` tag.
- Keep `BotaDeviceSDK`, `BotaDeviceSDKSpec`, `BotaDeviceClient`, `BotaClient`, Kotlin namespaces, Rust crate names, C/JNI symbols, native storage identities, and firmware behavior unchanged.
- Do not co-install old and new facades. Do not add compatibility wrappers, a relocation artifact, or duplicate native implementations.
- Keep physical-device verification status unchanged. Builds and package verification do not prove hardware acceptance.
- Do not rename, resume, or cancel beta.12 as part of implementation. Its immutable source remains its only release authority.
- Leave Windows, Electron, the maintenance SDK repositories, Demo, and Bota One code/dependencies untouched.
- Work on `main` as requested. Preserve unrelated changes and commit explicit file sets with `Co-Authored-By: OpenAI Codex <noreply@openai.com>`.
- Run local verification first. Do not push a release tag until the final source, registry setup, main-CI candidate inventory, and required approval gates are verified.

## Review Focus

1. Historical recovery uses current tooling on an old tree: test old layout and old coordinates, not only old manifest JSON (Tasks 1 and 3).
2. A partially renamed release could pass independent package checks: reject mixed native dependencies and old/new identifiers within a new candidate (Tasks 1 and 2).
3. A new npm name has no existing version/tag history: test missing tags separately from authentication/network errors and protect both old packages' tags (Task 3).
4. Flutter's `dart_package_name` contributes to generated message channels: preserve the explicit internal name and compare generated identities, not just compilation (Task 2).
5. A warm cache can conceal a stale package or local native override: build clean consumers from exact archives and exclusive repositories, then verify public resolution after publication (Tasks 4 and 6).

## File And Ownership Map

| Area | Files and responsibility |
| --- | --- |
| Shared release identity | New `tools/release/package-identities.mjs` and `.test.mjs`; `tools/xtask/src/lib.rs`; `release/schema/release-manifest.schema.json`: select the exact package matrix by validated SDK major. |
| Channel and regression gates | `tools/release/resolve-release-channel.mjs` and `.test.mjs`; `tools/release/release-manifest-schema.test.mjs`; `tools/xtask/tests/release_manifest.rs`, `release_readiness.rs`: preserve historical semantics and reject mismatches. |
| Native distributions | Root/development `Package.swift`; Apple sources/tests/podspec; `platforms/android/sdk/build.gradle.kts`; `tools/apple/`, `tools/android/`, and `tools/release/generate-*.mjs`: public names, archives, dependencies, and evidence. |
| Framework distributions | `frameworks/react-native/`, `frameworks/web/`, renamed `frameworks/flutter/bota_app_sdk/`; corresponding `tools/react-native/`, `tools/web/`, `tools/flutter/`: package imports, bridges, archive checks, and fresh consumers. |
| Version authority | `sdk-version.toml`, current package manifests/lockfiles, workspace Cargo members, Android properties, Swift version constant, Flutter packaged version, `protocol/compatibility/firmware-compatibility.json`: one current version. |
| Publication | `.github/workflows/ci.yml`, `release.yml`, `publish-apple-pod.yml`, `publish-flutter.yml`; candidate inventory and registry verifiers: current publication and historical recovery. |
| Docs | README, ARCHITECTURE, AGENTS, platform READMEs, `docs/releasing.md`, new migration guide; private architecture and public SDK reference in their owning repositories. |

Generated fixtures and historical evidence are not bulk-replacement targets.
Use the existing generator for every generated file. Keep pinned toolchain and
dependency versions; this change is not a dependency upgrade.

## Task 1: Version-Aware Identity And Historical Validation

**Interfaces:** Add `publicPackageIdentifier(platform, sdkVersion) -> string`
to `tools/release/package-identities.mjs`. Existing generator signatures and
`xtask::release::{verify_release, validate_manifest, validate_manifest_format_and_semantics}`
stay unchanged. Preserve manifest versions 1 and 2; select the version-2
package matrix by the validated SDK major rather than introducing another
manifest format for unchanged fields.

- [ ] Add the identity tests before implementation:

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';
import { publicPackageIdentifier } from './package-identities.mjs';

test('package identities separate historical and renamed releases', () => {
  const rows = [
    ['apple', 'BotaAppleSDK', 'BotaAppSDK'],
    ['android', 'dev.bota:bota-android-sdk', 'dev.bota:bota-app-sdk'],
    ['react-native', '@bota.dev/react-native-sdk', '@bota.dev/react-native-app-sdk'],
    ['web', '@bota.dev/web-sdk', '@bota.dev/web-app-sdk'],
    ['flutter', 'bota_flutter_sdk', 'bota_app_sdk'],
  ];
  for (const [platform, oldName, newName] of rows) {
    assert.equal(publicPackageIdentifier(platform, '1.2.0-beta.12'), oldName);
    assert.equal(publicPackageIdentifier(platform, '2.0.0-beta.0'), newName);
  }
  for (const version of ['v2.0.0-beta.0', '02.0.0-beta.0', '3.0.0-beta.0']) {
    assert.throws(() => publicPackageIdentifier('apple', version));
  }
  assert.throws(() => publicPackageIdentifier('windows', '2.0.0-beta.0'));
  assert.throws(() => publicPackageIdentifier('electron', '2.0.0-beta.0'));
});
```

- [ ] Run `node --test tools/release/package-identities.test.mjs` and confirm
  failure from the missing module. Implement the helper using existing SemVer
  validation in `parseReleaseRef`, then select the old map for majors 0/1 and
  the five new entries for major 2. Reject unknown platforms/majors. Retain
  historical Windows/Electron entries only in the old map; this does not
  authorize publishing them.
- [ ] Add Node/schema and Rust tests that construct synthetic in-memory v2
  manifests from the unchanged beta.12 fixture: set the SDK/artifact versions
  to `2.0.0-beta.0`, map all five package identifiers, and require acceptance.
  For each platform, restore only its old identifier and require rejection.
  Require the inverse rejection for a historical version carrying a new name.
  Keep all existing checksum, inventory, generator, and capability checks.
  Reject a manifest-v1 major-2 candidate instead of letting it bypass identity
  validation. Keep immutable v1 and v2 examples unchanged.
- [ ] Mirror identity selection in Rust and JSON Schema. In `verify_release`,
  choose the old/new Flutter directory and Apple podspec path from the parsed
  canonical version before reading files. Preserve this path map:

```text
1.x: frameworks/flutter/bota_flutter_sdk
     platforms/apple/BotaAppleSDK.podspec
2.x: frameworks/flutter/bota_app_sdk
     platforms/apple/BotaAppSDK.podspec
```

- [ ] Add channel tests for new `2.0.0-beta.0`, historical beta recovery, and
  historical `1.1.0` recovery; reject bare stable, `rc`, leading-zero, build
  metadata, `0.0.x`, and unapproved-major release inputs. Keep historical
  `1.x.y-beta.n` support and add only `2.x.y-beta.n` to the existing policy.
- [ ] Run the focused gates and commit `feat(release): support App SDK package identities`:

```bash
node --test tools/release/package-identities.test.mjs tools/release/resolve-release-channel.test.mjs tools/release/release-manifest-schema.test.mjs
cargo test -p xtask --test release_manifest
cargo test -p xtask --test release_readiness
git diff --check
```

## Task 2: Rename The Coupled Distributions And Local Consumers

This is one atomic metadata/import change because RN and Flutter consume both
native facades. Avoid committing a new framework package that still points to
old native coordinates. Release-workflow integration follows in Task 3; do not
push a tag or call the tree release-ready between these tasks.

**Interfaces:** The five package names change; exported runtime APIs, protocol
bytes, bridge IDs, and persistence identities do not. The identity helper from
Task 1 supplies expected names to generators and verification tools.

- [ ] Add red renderer tests to the existing Swift/podspec generator suites:

```javascript
test('major two changes the facade but not its core binary identity', () => {
  const rendered = renderPublicSwiftPackage({
    sdkVersion: '2.0.0-beta.0', artifactChecksum: 'a'.repeat(64),
  });
  assert.match(rendered, /name: "BotaAppSDK"/);
  assert.match(rendered, /Sources\/BotaAppSDK/);
  assert.match(rendered, /BotaDeviceSDKCore\.xcframework\.zip/);
  assert.match(rendered, /name: "BotaDeviceSDKC"/);
  assert.doesNotMatch(rendered, /BotaAppleSDK/);
});
```

  Add the equivalent podspec case for `BotaAppSDK.cocoapods.zip`, module name,
  and source path. Retain old-version renderer cases unchanged. Add negative
  cases to RN, Web, and Flutter package-verifier tests for old package names at
  version 2 and mismatched Apple/Maven dependencies.
- [ ] Check local and remote `v2.0.0-beta.0` tag occupancy, without creating a
  tag. Query candidate versions by exact registry name before selecting the
  version. Treat registry authentication/transport errors as unknown, not as
  availability. Stop for a new version decision if occupied.
- [ ] Rename these tracked paths using Git-aware moves:

```text
platforms/apple/Sources/BotaAppleSDK -> platforms/apple/Sources/BotaAppSDK
platforms/apple/Tests/BotaAppleSDKTests -> platforms/apple/Tests/BotaAppSDKTests
platforms/apple/Tests/BotaAppleSDKPhysicalTests -> platforms/apple/Tests/BotaAppSDKPhysicalTests
platforms/apple/BotaAppleSDK.podspec -> platforms/apple/BotaAppSDK.podspec
frameworks/flutter/bota_flutter_sdk -> frameworks/flutter/bota_app_sdk
frameworks/flutter/bota_app_sdk/lib/bota_flutter_sdk.dart -> frameworks/flutter/bota_app_sdk/lib/bota_app_sdk.dart
frameworks/flutter/bota_app_sdk/ios/bota_flutter_sdk.podspec -> frameworks/flutter/bota_app_sdk/ios/bota_app_sdk.podspec
frameworks/flutter/bota_app_sdk/ios/bota_flutter_sdk -> frameworks/flutter/bota_app_sdk/ios/bota_app_sdk
frameworks/flutter/bota_app_sdk/ios/bota_app_sdk/Sources/bota_flutter_sdk -> frameworks/flutter/bota_app_sdk/ios/bota_app_sdk/Sources/bota_app_sdk
```

  Update Swift manifests, test imports and names,
  source imports, pod references, fixture-sync destinations, and every local
  consumer referencing the renamed paths. Rename the Swift `BotaAppleSDK.swift`
  source filename to `BotaAppSDK.swift`; preserve its existing public
  `BotaAppleSDKVersion` enum and update only its version value. Renaming that
  metadata type is unnecessary for the distribution change.
- [ ] Change the Android artifact in `platforms/android/sdk/build.gradle.kts`
  to `bota-app-sdk`; change all current consumer and framework dependencies to
  `dev.bota:bota-app-sdk`. Do not change `dev.bota.sdk` or `com.bota.sdk` package
  declarations. Update native manifest/SBOM/archive generators and local Maven
  staging/verification paths using version-aware identities where they also
  inspect old artifacts.
- [ ] Set npm package names in RN/Web and Flutter's `pubspec.yaml`, library
  imports, example dependency, iOS product/pod metadata, and repository path
  to the approved names. Keep RN `BotaDeviceSDK.podspec`, native module, Codegen
  config, public exports, and its frozen maintenance-baseline metadata intact.
  Regenerate npm lock metadata with the pinned npm CLI, without upgrading
  resolved dependencies.
- [ ] Set `2.0.0-beta.0` in every current authority: root/npm packages and
  lockfiles; core/FFI/WASM, xtask, ffi-smoke, and uniffi-bindgen Cargo manifests
  and workspace lock; Android `VERSION_NAME`; Swift public version constant;
  Flutter pubspec, packaged Android TOML, exact Swift dependency; compatibility
  matrix; RN generated contract version via its generator. Do not replace
  version strings in historical examples, evidence, or regression fixtures.
- [ ] Preserve the explicit Pigeon channel name while changing output paths:

```json
{
  "swift_out": "ios/bota_app_sdk/Sources/bota_app_sdk/BotaApi.g.swift",
  "kotlin_package": "dev.bota.sdk.flutter",
  "dart_package_name": "bota_flutter_sdk"
}
```

  These are edits to the existing options object, not its complete contents.
  Explain the deliberately preserved channel identity in the Flutter README
  and verifier tests. Regenerate with `npm run flutter:generate`; compare the
  set of `dev.flutter.pigeon.*` channel strings against the pre-change files
  in all three languages. Require equality. Keep plugin classes unchanged.
- [ ] Update `tools/react-native/verify-package.mjs`, `tools/web/verify-package.mjs`,
  `tools/flutter/verify-package.mjs`, `verify-pigeon.mjs`, and
  `verify-publication.mjs`, plus their tests and shell consumer paths. Reuse
  version-aware identities for historical archive verification. Do not rename
  retained native runtime IDs through broad replacements.
- [ ] Run the focused gates, inspect the rename diff, and commit
  `feat(sdk): adopt App SDK distribution names`:

```bash
node --test tools/release/generate-*.test.mjs
npm run test:react-native
node --test tools/web/verify-package.test.mjs tools/flutter/verify-package.test.mjs tools/flutter/verify-publication.test.mjs
npm run flutter:generate:check
npm run codegen:check --prefix frameworks/react-native
git diff --check
```

## Task 3: Migrate Publication Without Breaking Recovery

**Files:** All four workflows in the ownership map; `tools/android/central-portal.mjs`
and its tests; native/CocoaPods/Flutter/public-consumer scripts; candidate
inventory tooling; `tools/xtask/tests/release_readiness.rs`; release-gate tests.

**Interfaces:** Existing release CLI and workflow inputs remain unchanged.
Recovery resolves names from the verified tag's version and preserved
inventories, never from the current workspace version or an arbitrary input.

- [ ] Add a red historical-source test using a disposable extraction of
  `v1.2.0-beta.12`. Build current xtask, then invoke its `release verify-tag`
  command from that extracted root. It must resolve old Flutter/Apple paths.
  Exercise the same helper with a current temporary-tree fixture. Keep this
  read-only to repositories and completely offline after local tag extraction.
  Also test signed Central recovery with both coordinate layouts, a preserved
  deployment UUID, and mismatched-name rejection before network access.
- [ ] Parameterize current publication and recovery names with the Task 1
  helper. For example, derive RN's exact name using the validated version:

```bash
RN_PACKAGE="$(node --input-type=module -e '
  import { publicPackageIdentifier } from "./tools/release/package-identities.mjs";
  console.log(publicPackageIdentifier("react-native", process.argv[1]));
' "$RELEASE_VERSION")"
PACKAGE_SPEC="$RN_PACKAGE@$RELEASE_VERSION"
```

  Apply this to npm lookups and verification, Central coordinate/archive
  paths, CocoaPods archive/Trunk lookup, Flutter public URLs, and post-publish
  consumers. Continue restoring the exact signed ZIP and resuming its recorded
  UUID; never rebuild signing bytes on recovery.
- [ ] Update CI paths, cache paths, artifact names, Swift schemes, and Flutter
  working directories. Keep the deliberately historical public beta.11
  CocoaPods smoke on `BotaAppleSDK`; make the public-pod consumer choose its
  pod/import by the requested version so it also tests new `BotaAppSDK`.
  Preserve Flutter's ordered prerequisites and `always()` success conditions.
- [ ] Add npm publication tests with mocked registry responses for: first
  package 404, existing matching hash, mismatched hash, delayed visibility,
  registry 401/403, and transport failure. Only a confirmed package/version
  absence permits first publication; never turn every failed lookup into empty
  state. Preserve the existing exact-tarball loop, explicit `--tag beta`, and
  checksum checks. Snapshot old package dist-tags before and after new-name
  publication and require equality. A missing `latest` on a new package is
  legitimate; unexpected creation/movement must be reported, not silently
  changed on the old package.
- [ ] Test that new candidates resolve only new native dependencies, old
  recovery resolves old dependencies, and the new Flutter publisher works from
  `frameworks/flutter/bota_app_sdk`. Use existing readiness/gate suites rather
  than replacing behavioral assertions with token-presence checks alone.
- [ ] Run and commit `fix(release): publish renamed packages with historical recovery`:

```bash
npm run test:release
node --test tools/web/release-gate.test.mjs
cargo test -p xtask --test release_readiness
git diff --check
```

## Task 4: Verify The Whole Local Candidate

**Interfaces:** Exact local artifacts feed clean consumers. No registry writes,
release tags, app rollout, or physical device writes occur in this task.

- [ ] Install locked dependencies with pinned Node/npm, prepare the exact
  maintenance references, and run early checks that do not require the new
  release example:

```bash
npm run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo xtask protocol generate --check
npm run baseline:react-native:api -- --sdk-path ../react-native-sdk
npm run test:workflows -- --sdk-path .ci/react-native-workflow-baseline
```

  If `.ci/react-native-workflow-baseline` is absent, populate it at the exact
  revision in compatibility metadata and install its locked dependencies.
  Do not use an arbitrary maintenance checkout for executable workflow proof.
- [ ] Run native tests, build exact local archives, and install the Android
  candidate into the exclusive test repository. Use the existing local package
  scripts rather than remote release URLs that do not exist yet:

```bash
tools/ffi-smoke/run-native-c-smoke.sh
tools/ffi-smoke/run-native-swift-smoke.sh
tools/apple/test-package.sh -Xswiftc -strict-concurrency=complete -Xswiftc -warnings-as-errors
tools/apple/test-consumer.sh
tools/apple/package-release.sh --write-package-manifest
tools/apple/test-pod-archive.sh
```

  Commit the generated root Swift manifest and podspec after checking their
  exact archive digests, so Android's clean-tree gate can run. Then verify the
  immutable local native candidates and consumers:

```bash
tools/apple/package-release.sh
tools/android/package-release.sh --check
tools/android/verify-publication.sh target/android-release
tools/android/install-release-repository.sh target/android-release target/android-m2
tools/android/test-legacy-consumer.sh --mode source --compile-only --repository target/android-m2
tools/android/test-legacy-consumer.sh --mode binary --compile-only --repository target/android-m2
tools/android/test-emulator-lane.sh --api 26
tools/android/test-emulator-lane.sh --api 35
```

  Supply the required JDK 17 and Android SDK environment from AGENTS. Packaging
  requires a clean tracked tree: commit tested source checkpoints first, then
  generate candidate evidence. Never use an old checksum as a stand-in for a
  new build. Record generator-produced Swift/pod checksums and rerun checks.
- [ ] Run framework gates and fresh consumers against the generated native
  candidates; inspect native dependencies and imports in the resulting locks:

```bash
npm run verify --prefix frameworks/react-native
npm run test:apple:lifecycle --prefix frameworks/react-native
npm run test:apple:integration --prefix frameworks/react-native
tools/react-native/test-android-adapter.sh --repository target/android-m2
npm run web:verify
npm run web:browser
npm run flutter:verify
npm run flutter:generate:check
tools/flutter/test-apple-adapter.sh
tools/flutter/test-android-adapter.sh
tools/flutter/test-consumers.sh
```

  Use RN's pinned Bundler/CocoaPods environment for its Apple integration
  command. Pack RN with `npm@12.0.2 pack --json` from its package directory
  into `target/react-native-release` and preserve the JSON result; Web's
  consumer gate already preserves its exact tarball in `target/web-release`.
- [ ] Seed the new manifest template from the unchanged historical structure
  and newly built non-Flutter files. Do not copy old artifact hashes. The
  Flutter writer fills the final entry from its freshly verified inventory.
  Run this generated-data command from the repository root:

```javascript
// Execute with node --input-type=module; writes generated evidence only.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { publicPackageIdentifier } from './tools/release/package-identities.mjs';

const version = '2.0.0-beta.0';
const manifest = JSON.parse(readFileSync('release/examples/1.2.0-beta.12.json'));
manifest.sdkVersion = version;
manifest.sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const roots = { apple: 'apple-release', android: 'android-release',
  'react-native': 'react-native-release', web: 'web-release' };
manifest.artifacts = manifest.artifacts.map(({ platform, ecosystem, capabilities }) => {
  const base = { platform, ecosystem, capabilities, version,
    packageIdentifier: publicPackageIdentifier(platform, version) };
  if (platform === 'flutter') return base;
  const root = `target/${roots[platform]}`;
  const names = platform === 'apple' ? ['BotaDeviceSDKCore.xcframework.zip']
    : readdirSync(root).filter((name) => name.endsWith(platform === 'android' ? '.aar' : '.tgz'));
  if (names.length !== 1) throw new Error(`ambiguous ${platform} candidate`);
  const name = names[0];
  const checksumSha256 = createHash('sha256').update(readFileSync(`${root}/${name}`)).digest('hex');
  return { ...base, name, checksumSha256 };
});
writeFileSync(`release/examples/${version}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
```

  This intermediate template is not valid release evidence and must not be
  committed or tagged before the next writer/gates complete. Do not add a
  permanent helper solely for this one-time generated-data step.
- [ ] Generate the Flutter evidence and run the final complete gates:

```bash
tools/flutter/package-release.sh --write-example
tools/flutter/package-release.sh --check
npm run test:tooling
npm run test:release
cargo test --workspace
cargo xtask release verify-tag v2.0.0-beta.0
git diff --check
```

  `verify-tag` validates metadata without creating a tag. Keep old examples
  byte-for-byte unchanged. If a gate requires a clean tree, first commit the
  locally validated generated output, then repeat the full gate; do not
  weaken the clean-tree check.
- [ ] Commit generated checksums, inventories, and reviewed evidence as
  `chore(release): record renamed SDK candidate verification`. Record any
  unavailable platform gate as incomplete; do not substitute a static check
  or a cached consumer for a failing build.

## Task 5: Publish Accurate Migration Documentation

**Files:** Create `docs/migrations/app-sdk-package-names.md`. Update README,
ARCHITECTURE, AGENTS, `docs/releasing.md`, platform/framework READMEs, and the
current naming spec. In their owning repositories, update
`internal-docs/App SDK Architecture.md` and `docs/api-reference/client-sdks.mdx`
after reading their instructions and preserving unrelated edits.

- [ ] Write exact old/new installation and import examples, including:

```text
Swift: import BotaAppSDK; product BotaAppSDK; exact tag 2.0.0-beta.0
Gradle: implementation("dev.bota:bota-app-sdk:2.0.0-beta.0")
npm: npm install @bota.dev/react-native-app-sdk@2.0.0-beta.0
npm: npm install @bota.dev/web-app-sdk@2.0.0-beta.0
Dart: import 'package:bota_app_sdk/bota_app_sdk.dart';
```

  Label these prepared instructions until the corresponding registry artifact
  is verified public. Explain removing the old dependency before adding its
  replacement, rebuilding RN/Flutter native apps, and leaving maintenance RN
  installations unchanged. Do not suggest installing both facade names.
- [ ] Replace current naming matrices, not historical release records. Record
  internal-name exceptions, version-aware recovery, registry bootstrap gates,
  and the unchanged hardware acceptance status. Update the internal docs index
  and run its required `scripts/gen-llms-full.py` generator when that repo changes.
- [ ] Search all public/internal docs and every repository's README, AGENTS,
  and ARCHITECTURE for both old and new tokens. Classify remaining old hits as
  historical evidence, maintenance instructions, preserved bridge identity,
  or a missed current reference. Inspect links and run the owning repo's doc
  checks. Keep commits separate by repository and purpose.
- [ ] Commit `docs: explain App SDK package migration`, marking implementation
  complete only for verified source/build changes, not for pending publication.

## Task 6: Main CI And Registry Rollout

This is the external rollout phase, after implementation review. Missing
registry ownership, interactive login, or protected-environment approval is
an explicit external gate; never bypass it to mark this task complete.

- [ ] Verify a clean reviewed `main`, push the implementation commits, and
  require green CI/license/security checks at that exact revision. Download
  `release-candidate-<commit>` and verify its five-platform inventory and source
  revision. Local builds alone are not the tag's candidate authority.
- [ ] Verify organization access to all five new identities and configure
  their package-specific publication authorization. Keep old npm publisher
  settings intact for old-version recovery. Follow official registry bootstrap
  procedures for first publication, using only approved exact artifacts; do
  not create dummy packages or stored npm write tokens.
- [ ] Record old RN/Web dist-tags, available legacy versions, and occupied
  new-name versions as read-only preflight evidence. Recheck the intended tag
  is unused. Create the annotated tag only from the approved main-CI inventory
  using the source and inventory digest format in `docs/releasing.md`.
- [ ] Run the existing protected release order: native dependencies, exact npm
  artifacts, public Apple/Android consumers, exact Flutter candidate, pub.dev
  bootstrap/automated publication, public Flutter verification. Preserve
  signed deployment state across uncertain attempts and retry the same
  immutable candidates, not a newly packed archive.
- [ ] Verify public bytes, resolved native dependency versions, npm beta tags,
  and unchanged legacy tags. Run public SwiftPM/CocoaPods, Maven, RN, Web, and
  Flutter consumer checks. Attach evidence through the existing release process.
- [ ] Report source migration, package publication, application rollout, and
  hardware acceptance separately. Do not upgrade Demo/Bota One or claim
  physical acceptance as part of a package-name release.

## Execution Handoff

Recommend native execution in this task: identity selection, imports, source
moves, and generated evidence are tightly coupled. Use focused commits after
the tests above, then an independent review of the complete change before
external rollout. Do not claim an independent review unless it occurred.
