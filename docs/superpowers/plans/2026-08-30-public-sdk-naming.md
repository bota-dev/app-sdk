# Public SDK Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the approved Bota App SDK family and platform package names in release metadata and all maintained architecture documentation without mutating the published `v1.0.0` release or renaming legacy package code.

**Architecture:** Release manifest version 2 adds a top-level `sdkFamily` and per-artifact `platform` and `packageIdentifier`, while the validator continues accepting immutable version 1 manifests. The Apple generator emits version 2 for future evidence. Canonical internal documentation is renamed to Bota App SDK Architecture, and downstream repositories describe their current packages as migration inputs until each facade is replaced.

**Tech Stack:** Rust 1.98, serde, JSON Schema 2020-12, Node.js 22, SwiftPM release tooling, Markdown, Git.

**Spec:** `docs/superpowers/specs/2026-08-30-public-sdk-naming-design.md`

## Global Constraints

- The public family name is **Bota App SDK**.
- Public documentation uses **Bota SDK for _platform_**.
- The future backend family remains **Bota API SDK**.
- Apple uses `BotaAppleSDK`.
- Android uses `dev.bota:bota-android-sdk`.
- React Native keeps `@bota.dev/react-native-sdk`.
- Flutter uses `bota_flutter_sdk`; Web uses `@bota.dev/web-sdk`; Windows uses `Bota.WindowsSdk`.
- Electron gets `@bota.dev/electron-sdk` only when a dedicated native desktop bridge exists.
- Internal `bota-device-sdk-core`, `bota-device-sdk-ffi`, and `BotaDeviceSDKC` names remain unchanged.
- Do not move `v1.0.0`, replace its release assets, or rewrite its published version 1 manifest.
- Do not rename code in `bota-mobile-sdk-ios` or `bota-mobile-sdk-android`; those repositories remain migration inputs.
- Preserve unrelated local modifications, especially the existing uncommitted `AGENTS.md` additions in both legacy native repositories.

---

### Task 1: Add Backward-Compatible Release Manifest Version 2

**Files:**
- Modify: `release/schema/release-manifest.schema.json`
- Modify: `tools/xtask/src/lib.rs`
- Modify: `tools/xtask/tests/release_manifest.rs`
- Create: `release/examples/published-1.0.0-v1.json`
- Modify: `release/examples/1.0.0.json`

**Interfaces:**
- Consumes: version 1 manifests with the existing six required top-level fields.
- Produces: version 2 manifests with `sdkFamily: "bota-app-sdk"` and artifact fields `platform` and `packageIdentifier`.
- Produces: `validate_manifest(path: &Path) -> Result<(), String>` support for versions 1 and 2.

- [ ] **Step 1: Preserve the published version 1 example**

Copy the current `release/examples/1.0.0.json` content to
`release/examples/published-1.0.0-v1.json` without changing its values. This
fixture represents the immutable manifest already attached to the public
release.

- [ ] **Step 2: Write failing validator tests**

Add these cases to `tools/xtask/tests/release_manifest.rs`:

```rust
#[test]
fn published_v1_manifest_remains_valid() {
    let manifest = root().join("release/examples/published-1.0.0-v1.json");
    let result = xtask::release::validate_manifest(&manifest);
    assert!(result.is_ok(), "{result:?}");
}

#[test]
fn v2_manifest_requires_the_app_sdk_family() {
    let result = validate_modified("sdk-family", |manifest| {
        manifest.as_object_mut().unwrap().remove("sdkFamily");
    });
    assert!(result.unwrap_err().contains("sdkFamily"));
}

#[test]
fn v2_artifact_package_must_match_its_platform() {
    let result = validate_modified("package-identifier", |manifest| {
        manifest["artifacts"][0]["packageIdentifier"] = "BotaSDK".into();
    });
    assert!(result.unwrap_err().contains("packageIdentifier"));
}
```

Change `release/examples/1.0.0.json` to the desired version 2 shape before
running the tests:

```json
{
  "manifestVersion": 2,
  "sdkFamily": "bota-app-sdk",
  "artifacts": [
    {
      "platform": "apple",
      "packageIdentifier": "BotaAppleSDK"
    }
  ]
}
```

Retain every existing version, revision, checksum, compatibility, and
capability value around those additions.

- [ ] **Step 3: Run the validator tests and verify RED**

Run:

```bash
cargo test -p xtask --test release_manifest
```

Expected: the version 1 compatibility test passes, while version 2 tests fail
because `manifestVersion` only accepts `1` and the new fields are rejected as
unknown.

- [ ] **Step 4: Implement version 2 schema support**

In the JSON schema:

```json
"$id": "https://bota.dev/schemas/app-sdk-release-manifest.json",
"manifestVersion": { "enum": [1, 2] },
"sdkFamily": { "const": "bota-app-sdk" }
```

Add optional artifact properties:

```json
"platform": {
  "enum": ["apple", "android", "react-native", "flutter", "web", "windows", "electron"]
},
"packageIdentifier": { "type": "string", "minLength": 1 }
```

Use a top-level conditional so version 2 requires `sdkFamily`, `platform`, and
`packageIdentifier`; version 1 remains valid without them.

In `tools/xtask/src/lib.rs`, deserialize the additions as options:

```rust
sdk_family: Option<String>,
platform: Option<String>,
package_identifier: Option<String>,
```

Validate version 2 against this exact matrix:

```rust
const APP_SDK_PACKAGES: &[(&str, &str)] = &[
    ("apple", "BotaAppleSDK"),
    ("android", "dev.bota:bota-android-sdk"),
    ("react-native", "@bota.dev/react-native-sdk"),
    ("flutter", "bota_flutter_sdk"),
    ("web", "@bota.dev/web-sdk"),
    ("windows", "Bota.WindowsSdk"),
    ("electron", "@bota.dev/electron-sdk"),
];
```

Reject unknown manifest versions, a version 2 family other than
`bota-app-sdk`, a missing platform/package identifier, or a platform/package
pair that differs from the matrix.

- [ ] **Step 5: Run schema and validator tests and verify GREEN**

Run:

```bash
cargo test -p xtask --test release_manifest
cargo xtask release validate release/examples/published-1.0.0-v1.json
cargo xtask release validate release/examples/1.0.0.json
```

Expected: all tests pass and both manifest versions validate.

- [ ] **Step 6: Commit manifest version 2**

```bash
git add release/schema/release-manifest.schema.json \
  release/examples/published-1.0.0-v1.json release/examples/1.0.0.json \
  tools/xtask/src/lib.rs tools/xtask/tests/release_manifest.rs
git commit -m "feat(release): identify public SDK packages"
```

---

### Task 2: Emit Naming Metadata from Apple Release Tooling

**Files:**
- Modify: `tools/release/generate-apple-manifest.test.mjs`
- Modify: `tools/release/generate-apple-manifest.mjs`
- Modify: `tools/release/generate-apple-sbom.test.mjs`
- Modify: `tools/release/generate-apple-sbom.mjs`
- Modify: `docs/releasing.md`

**Interfaces:**
- Consumes: `generateAppleManifest({ sdkVersion, sourceRevision, artifactChecksum, baseline, compatibility })`.
- Produces: release manifest version 2 for family `bota-app-sdk`, platform `apple`, package `BotaAppleSDK`.
- Produces: SPDX namespace `https://bota.dev/spdx/app-sdk/<version>/<revision>`.

- [ ] **Step 1: Write failing generator assertions**

Add these assertions to the primary Apple manifest test:

```javascript
assert.equal(manifest.manifestVersion, 2);
assert.equal(manifest.sdkFamily, 'bota-app-sdk');
assert.equal(manifest.artifacts[0].platform, 'apple');
assert.equal(manifest.artifacts[0].packageIdentifier, 'BotaAppleSDK');
```

Change the SPDX test to require:

```javascript
assert.equal(
  document.documentNamespace,
  `https://bota.dev/spdx/app-sdk/1.0.0-alpha.1/${sourceRevision}`
);
```

- [ ] **Step 2: Run Node tests and verify RED**

Run:

```bash
node --test tools/release/generate-apple-manifest.test.mjs \
  tools/release/generate-apple-sbom.test.mjs
```

Expected: assertions fail because the generator still emits manifest version 1
and the SPDX namespace still contains `device-sdk`.

- [ ] **Step 3: Update the generators**

Change `generate-apple-manifest.mjs` to emit:

```javascript
return {
  manifestVersion: 2,
  sdkFamily: 'bota-app-sdk',
  sdkVersion,
  // existing evidence fields remain unchanged
  artifacts: [{
    name: 'BotaDeviceSDKCore.xcframework.zip',
    ecosystem: 'swiftpm',
    platform: 'apple',
    packageIdentifier: 'BotaAppleSDK',
    version: sdkVersion,
    checksumSha256: artifactChecksum,
    capabilities,
  }],
};
```

Change only the public SPDX namespace from `/device-sdk/` to `/app-sdk/`.
Keep the internal XCFramework name and Rust/C dependency names unchanged.

- [ ] **Step 4: Document manifest compatibility**

In `docs/releasing.md`, state that future packaging emits manifest version 2
with family/platform/package identity, while the public `v1.0.0` manifest is an
immutable version 1 document accepted by the validator.

- [ ] **Step 5: Run release tooling tests**

Run:

```bash
npm run test:release
```

Expected: all release generator tests pass.

- [ ] **Step 6: Commit Apple naming metadata**

`tools/apple/package-release.sh` requires a clean source tree, so commit the
unit-tested generator before running the package-level gate:

```bash
git add tools/release/generate-apple-manifest.mjs \
  tools/release/generate-apple-manifest.test.mjs \
  tools/release/generate-apple-sbom.mjs \
  tools/release/generate-apple-sbom.test.mjs docs/releasing.md
git commit -m "feat(apple): emit App SDK release identity"
```

- [ ] **Step 7: Package and inspect clean release evidence**

Run:

```bash
tools/apple/package-release.sh
jq '{manifestVersion, sdkFamily, artifact: .artifacts[0] | {platform, packageIdentifier}}' \
  target/apple-release/release-manifest.json
```

Expected JSON:

```json
{
  "manifestVersion": 2,
  "sdkFamily": "bota-app-sdk",
  "artifact": {
    "platform": "apple",
    "packageIdentifier": "BotaAppleSDK"
  }
}
```

---

### Task 3: Align App SDK Repository Documentation

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-08-30-native-facades-design.md`
- Modify: `docs/superpowers/plans/2026-08-28-app-sdk-implementation.md`
- Modify: `docs/superpowers/plans/2026-08-30-app-sdk-workflow-core.md`

**Interfaces:**
- Consumes: the approved platform matrix from the naming specification.
- Produces: one authoritative public naming table and an Android coordinate of `dev.bota:bota-android-sdk`.

- [ ] **Step 1: Add the platform naming table to the README**

Expand the existing `## Naming` section with the exact family, documentation,
and package identifiers from the specification. Keep `BotaAppleSDK` installation
instructions unchanged.

- [ ] **Step 2: Update architecture and agent context**

Document manifest version 2 and the separation between customer-facing package
names and internal `device-sdk` core/ABI names. Replace the Android coordinate
`dev.bota:device-sdk-android` in the native-facades design with
`dev.bota:bota-android-sdk`.

- [ ] **Step 3: Repair private-design references in historical plans**

Change links and prose references from `Device SDK Architecture.md` to
`App SDK Architecture.md`. Do not rewrite completed implementation history or
internal Rust/C symbol names.

- [ ] **Step 4: Verify repository naming consistency**

Run:

```bash
rg -n "dev\.bota:device-sdk-android|Bota Device SDK family|Device SDK Architecture\.md" \
  README.md ARCHITECTURE.md AGENTS.md docs
```

Expected: no stale public-family, Android-coordinate, or architecture-filename
matches. Negative explanatory text such as “must not use Bota Device SDK” and
internal artifact names remain allowed.

- [ ] **Step 5: Commit App SDK documentation**

```bash
git add README.md ARCHITECTURE.md AGENTS.md docs/superpowers
git commit -m "docs: apply App SDK naming contract"
```

---

### Task 4: Rename and Update the Canonical Internal Architecture

**Files:**
- Rename: `../internal-docs/Device SDK Architecture.md` to `../internal-docs/App SDK Architecture.md`
- Modify: `../internal-docs/App SDK Architecture.md`
- Modify: `../internal-docs/Mobile SDK System Design.md`
- Modify: `../internal-docs/ARCHITECTURE.md`
- Modify: `../internal-docs/CLAUDE.md`
- Modify: `../internal-docs/llms.txt`
- Regenerate: `../internal-docs/llms-full.txt`

**Interfaces:**
- Consumes: the approved public naming specification.
- Produces: the canonical cross-system architecture under the Bota App SDK name.

- [ ] **Step 1: Rename the architecture document**

Use Git-aware rename semantics so history remains traceable:

```bash
git -C ../internal-docs mv "Device SDK Architecture.md" "App SDK Architecture.md"
```

- [ ] **Step 2: Apply the naming taxonomy**

Change the title to `# Bota App SDK Architecture`. Replace the public family
name and public platform package matrix with the approved names. Keep references
to physical devices, device-facing behavior, and internal `device-sdk` artifacts
where those terms describe function rather than product branding.

The public entry-point section must use `BotaDeviceClient` for new native
facades. The existing React Native `BotaClient` remains its compatibility entry
point; this avoids claiming an immediate breaking rename across existing SDKs.

- [ ] **Step 3: Update every internal link and index entry**

Update `Mobile SDK System Design.md`, `ARCHITECTURE.md`, `CLAUDE.md`, and
`llms.txt` to the new filename and family. The `llms.txt` summary must name
**Bota App SDK**, retain the Bota API SDK separation, and describe the same Rust
core and native-adapter architecture.

- [ ] **Step 4: Regenerate the internal documentation bundle**

Run:

```bash
cd ../internal-docs
python3 scripts/gen-llms-full.py
```

Expected: the command completes successfully, includes `App SDK Architecture.md`,
and removes the old filename from `llms-full.txt`.

- [ ] **Step 5: Verify internal documentation**

Run:

```bash
rg -n "Device SDK Architecture\.md|Device%20SDK%20Architecture\.md|Bota Device SDK" \
  --glob '!archive/**' --glob '!llms-full.txt' .
```

Expected: no stale public-family or old-filename references; internal artifact
names and explicit rejected-name explanations are reviewed individually.

- [ ] **Step 6: Commit and push internal documentation**

```bash
git -C ../internal-docs add -A
git -C ../internal-docs commit -m "docs: rename the Bota App SDK architecture"
git -C ../internal-docs push origin main
```

---

### Task 5: Synchronize Downstream SDK Context

**Files:**
- Modify locally: `../AGENTS.md`
- Modify: `../react-native-sdk/AGENTS.md`
- Modify: `../react-native-sdk/ARCHITECTURE.md`
- Modify: `../react-native-sdk/README.md`
- Modify: `../bota-mobile-sdk-ios/AGENTS.md`
- Modify: `../bota-mobile-sdk-ios/README.md`
- Modify: `../bota-mobile-sdk-ios/ARCHITECTURE.md`
- Modify: `../bota-mobile-sdk-android/AGENTS.md`
- Modify: `../bota-mobile-sdk-android/README.md`
- Modify: `../bota-mobile-sdk-android/ARCHITECTURE.md`

**Interfaces:**
- Consumes: `App SDK Architecture.md` and the package naming matrix.
- Produces: consistent agent and public context without changing legacy source/package identifiers.

- [ ] **Step 1: Update workspace context**

In the wrapper `AGENTS.md`, change the family to **Bota App SDK**, link to
`internal-docs/App SDK Architecture.md`, describe `app-sdk` as the target
monorepo, and retain the rule that old repositories remain migration inputs
until their acceptance gates pass.

- [ ] **Step 2: Update React Native documentation**

Keep `@bota.dev/react-native-sdk` unchanged. Name its family **Bota App SDK**,
repair the architecture link, and update the repository matrix to include the
public `BotaAppleSDK` from `app-sdk`. Label `bota-mobile-sdk-ios` and
`bota-mobile-sdk-android` as legacy migration inputs rather than future public
package names.

Run:

```bash
cd ../react-native-sdk
npm run build
npm test -- --runInBand
```

Expected: build and tests pass with no package identifier change.

- [ ] **Step 3: Commit and push React Native documentation**

```bash
git -C ../react-native-sdk add AGENTS.md ARCHITECTURE.md README.md
git -C ../react-native-sdk commit -m "docs: align with the Bota App SDK family"
git -C ../react-native-sdk push origin main
```

- [ ] **Step 4: Update legacy Apple documentation without renaming code**

Preserve the current uncommitted `AGENTS.md` paragraph, changing its proposed
family and architecture link in place. State that the Swift module remains
`BotaSDK` in this migration-input repository and that new consumers use
`BotaAppleSDK` from `app-sdk`.

Run:

```bash
cd ../bota-mobile-sdk-ios
swift test
```

Expected: all existing tests pass; `Package.swift` and `Sources/BotaSDK` remain
unchanged.

- [ ] **Step 5: Commit and push legacy Apple documentation**

```bash
git -C ../bota-mobile-sdk-ios add AGENTS.md README.md ARCHITECTURE.md
git -C ../bota-mobile-sdk-ios commit -m "docs: mark the Apple SDK migration path"
git -C ../bota-mobile-sdk-ios push origin main
```

- [ ] **Step 6: Update legacy Android documentation without renaming code**

Preserve the current uncommitted `AGENTS.md` paragraph, changing its proposed
family and architecture link in place. State that the current Gradle project and
`com.bota.sdk` namespace remain migration inputs; the future app-sdk artifact is
`dev.bota:bota-android-sdk`.

Run:

```bash
cd ../bota-mobile-sdk-android
ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest
```

Expected: all existing unit tests pass; Kotlin package declarations and Gradle
coordinates remain unchanged.

- [ ] **Step 7: Commit and push legacy Android documentation**

```bash
git -C ../bota-mobile-sdk-android add AGENTS.md README.md ARCHITECTURE.md
git -C ../bota-mobile-sdk-android commit -m "docs: mark the Android SDK migration path"
git -C ../bota-mobile-sdk-android push origin main
```

---

### Task 6: Run Cross-Repository Verification and Publish Main

**Files:**
- Verify: all files changed in Tasks 1-5

**Interfaces:**
- Consumes: release schema v2, Apple generator metadata, canonical docs, and downstream context.
- Produces: pushed `main` branches with no stale public naming references.

- [ ] **Step 1: Run the complete App SDK gate**

Run from `app-sdk`:

```bash
npm run test:tooling
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
tools/apple/test-package.sh -Xswiftc -strict-concurrency=complete -Xswiftc -warnings-as-errors
tools/apple/test-consumer.sh
tools/apple/package-release.sh
git diff --check
```

Expected: every command exits zero; physical-device tests remain opt-in and are
not claimed by this documentation/metadata change.

- [ ] **Step 2: Search the complete maintained workspace**

Run from the workspace root:

```bash
rg -n "Device SDK Architecture\.md|Device%20SDK%20Architecture\.md|dev\.bota:device-sdk-android|Bota Device SDK family" \
  --glob '!**/.git/**' --glob '!**/node_modules/**' --glob '!**/target/**' \
  --glob '!internal-docs/archive/**'
```

Expected: no stale path, public family, or superseded Android coordinate.
Explicit rejected-name prose and internal Rust/C symbols are not search errors.

- [ ] **Step 3: Commit and push the App SDK branch**

If verification produced no new tracked output, push the commits from Tasks
1-3 directly:

```bash
git status --short --branch
git push origin main
```

Expected: `main` is clean and synchronized with `origin/main`.

- [ ] **Step 4: Confirm repository heads and CI**

Record the final commit for `app-sdk`, `internal-docs`, `react-native-sdk`,
`bota-mobile-sdk-ios`, and `bota-mobile-sdk-android`. Confirm each pushed branch
is `main`; confirm App SDK CI and license workflows complete successfully.

- [ ] **Step 5: Start the Android facade plan**

Use `docs/superpowers/specs/2026-08-30-native-facades-design.md` as the accepted
architecture and create a separate Android implementation/publishing plan. Its
public Maven coordinate must be `dev.bota:bota-android-sdk`; it must not be
combined with the naming-migration commits above.
