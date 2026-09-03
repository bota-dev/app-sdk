# SDK Release Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `@bota.dev/react-native-sdk` `0.0.x` as the production `latest` line while publishing synchronized Bota App SDK releases as explicit `1.x.y-beta.n` beta artifacts across npm, SwiftPM, Maven Central, and GitHub.

**Architecture:** A small policy resolver in `app-sdk` converts an exact release ref into one version and channel decision consumed by the protected release workflow. The legacy React Native repository stops publishing from CI and instead produces a checksum-bound `0.0.x` candidate for a maintainer to publish interactively with WebAuthn. Mutable npm dist-tags and the existing GitHub release are migrated once, while all package versions and native artifacts remain immutable.

**Tech Stack:** Node.js 24 ESM and `node:test`, Rust `xtask` workflow assertions, GitHub Actions, npm 12.0.2 trusted publishing and dist-tags, SwiftPM, Maven Central, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-09-02-sdk-release-channels-design.md`

## Global Constraints

- The legacy React Native maintenance line uses versions matching `0.0.x` and owns npm tag `latest`.
- The synchronized App SDK beta line uses versions matching `1.x.y-beta.n` and owns npm tag `beta`.
- Apple, Android, and React Native App SDK artifacts always use the exact version in `sdk-version.toml`.
- The next synchronized release is `1.2.0-beta.0`; do not rename, republish, unpublish, or recreate immutable `1.1.0` artifacts.
- The npm trusted publisher remains `bota-dev/app-sdk`, workflow `release.yml`, environment `release`.
- The legacy repository never stores an npm write token and never executes `npm publish` in GitHub Actions.
- New App SDK tag runs reject stable versions while beta policy is active; recovery may resume the historical exact `v1.1.0` release.
- App SDK npm publication always uses `--tag beta` and must prove the prior `latest` value is unchanged.
- Legacy publication always uses `--tag latest` and must prove the prior `beta` value is unchanged.
- Demo and Bota One remain exactly pinned to `@bota.dev/react-native-sdk@1.1.0`; the dist-tag migration must not rewrite either lockfile.
- Preserve the pre-existing uncommitted changes in `app-sdk/AGENTS.md` and `app-sdk/ARCHITECTURE.md`; do not stage or rewrite those files as part of this work.
- Preserve every pre-existing uncommitted file in `docs` and `internal-docs`; only release-channel files or release-channel hunks may be staged.

---

### Task 1: Add the App SDK release-channel policy resolver

**Files:**
- Create: `release/channel-policy.json`
- Create: `tools/release/resolve-release-channel.mjs`
- Create: `tools/release/resolve-release-channel.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `parseReleaseRef(ref: string): string`, returning the SemVer portion of an exact `refs/tags/v<version>` or `v<version>` ref.
- Produces: `resolveReleaseChannel({ ref: string, mode: "new" | "recovery", policy: ChannelPolicy }): { version: string, npmTag: "beta", githubPrerelease: true }`.
- Produces CLI: `node tools/release/resolve-release-channel.mjs --ref <ref> --mode <new|recovery> [--github-output <path>]`.
- Produces GitHub outputs named `version`, `npm_tag`, and `github_prerelease`.

- [ ] **Step 1: Add the failing policy tests**

Create `tools/release/resolve-release-channel.test.mjs` with these cases:

```js
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  parseReleaseRef,
  resolveReleaseChannel,
  run,
} from './resolve-release-channel.mjs';

test('new App SDK releases resolve to beta and GitHub prerelease', () => {
  assert.deepEqual(
    resolveReleaseChannel({
      ref: 'refs/tags/v1.2.0-beta.0',
      mode: 'new',
      policy: testPolicy,
    }),
    { version: '1.2.0-beta.0', npmTag: 'beta', githubPrerelease: true },
  );
});

test('new stable App SDK tags are rejected while beta policy is active', () => {
  assert.throws(
    () => resolveReleaseChannel({
      ref: 'refs/tags/v1.2.0',
      mode: 'new',
      policy: testPolicy,
    }),
    /must contain a prerelease component/,
  );
});

test('build metadata is not mistaken for a prerelease component', () => {
  assert.throws(
    () => resolveReleaseChannel({
      ref: 'refs/tags/v1.2.0+build-1',
      mode: 'new',
      policy: testPolicy,
    }),
    /must contain a prerelease component/,
  );
});

test('historical stable release recovery remains possible', () => {
  assert.deepEqual(
    resolveReleaseChannel({
      ref: 'refs/tags/v1.1.0',
      mode: 'recovery',
      policy: testPolicy,
    }),
    { version: '1.1.0', npmTag: 'beta', githubPrerelease: true },
  );
});

test('only exact release tag refs are accepted', () => {
  assert.equal(parseReleaseRef('v1.2.0-beta.0'), '1.2.0-beta.0');
  assert.throws(() => parseReleaseRef('refs/heads/main'), /release tag/);
  assert.throws(() => parseReleaseRef('v01.2.0-beta.0'), /semantic version/);
});

test('CLI writes stable GitHub output names', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bota-release-channel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'github-output');
  await run([
    '--ref', 'refs/tags/v1.2.0-beta.0',
    '--mode', 'new',
    '--github-output', output,
  ]);
  assert.equal(
    await readFile(output, 'utf8'),
    'version=1.2.0-beta.0\nnpm_tag=beta\ngithub_prerelease=true\n',
  );
});
```

Define `testPolicy` at the top of the test as:

```js
const testPolicy = {
  schemaVersion: 1,
  appSdkChannel: 'beta',
  npmDistTag: 'beta',
  githubPrerelease: true,
  requirePrereleaseForNewTags: true,
};
```

- [ ] **Step 2: Run the focused tests and confirm the missing module failure**

Run:

```bash
node --test tools/release/resolve-release-channel.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `resolve-release-channel.mjs`.

- [ ] **Step 3: Add the explicit channel policy**

Create `release/channel-policy.json`:

```json
{
  "schemaVersion": 1,
  "appSdkChannel": "beta",
  "npmDistTag": "beta",
  "githubPrerelease": true,
  "requirePrereleaseForNewTags": true
}
```

- [ ] **Step 4: Implement the resolver and CLI**

Implement `tools/release/resolve-release-channel.mjs` around these exact exports:

```js
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const policyUrl = new URL('../../release/channel-policy.json', import.meta.url);

export function parseReleaseRef(ref) {
  const tag = ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : ref;
  if (!tag.startsWith('v')) throw new Error(`${ref} is not an exact release tag`);
  const version = tag.slice(1);
  if (!SEMVER.test(version)) throw new Error(`${version} is not a valid semantic version`);
  return version;
}

export async function loadPolicy() {
  return JSON.parse(await readFile(policyUrl, 'utf8'));
}

export function resolveReleaseChannel({ ref, mode, policy }) {
  if (mode !== 'new' && mode !== 'recovery') throw new Error(`invalid mode ${mode}`);
  if (
    policy.schemaVersion !== 1 ||
    policy.appSdkChannel !== 'beta' ||
    policy.npmDistTag !== 'beta' ||
    policy.githubPrerelease !== true
  ) {
    throw new Error('unsupported release channel policy');
  }
  const version = parseReleaseRef(ref);
  const versionWithoutBuildMetadata = version.split('+', 1)[0];
  if (
    mode === 'new' &&
    policy.requirePrereleaseForNewTags &&
    !versionWithoutBuildMetadata.includes('-')
  ) {
    throw new Error(`new App SDK version ${version} must contain a prerelease component`);
  }
  return {
    version,
    npmTag: policy.npmDistTag,
    githubPrerelease: policy.githubPrerelease,
  };
}
```

Complete `run(argv)` with strict parsing for `--ref`, `--mode`, and optional `--github-output`. Load the policy once, call `resolveReleaseChannel`, print JSON when no output path is provided, and append the three exact output lines when it is provided. Guard direct CLI execution by comparing `resolve(process.argv[1])` with `fileURLToPath(import.meta.url)`.

- [ ] **Step 5: Include the resolver in package commands**

The existing `test:release` glob already includes `tools/release/*.test.mjs`. Add this convenience script without changing the existing gate:

```json
"release:channel": "node tools/release/resolve-release-channel.mjs"
```

- [ ] **Step 6: Run the release tests**

Run:

```bash
npm run test:release
```

Expected: all release, Android publication, and channel resolver tests PASS.

- [ ] **Step 7: Commit the policy resolver**

```bash
git add release/channel-policy.json \
  tools/release/resolve-release-channel.mjs \
  tools/release/resolve-release-channel.test.mjs \
  package.json
git commit -m "build(release): define beta channel policy"
```

---

### Task 2: Make the protected App SDK workflow version-driven and beta-only

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `tools/xtask/tests/release_readiness.rs`
- Test: `tools/release/resolve-release-channel.test.mjs`

**Interfaces:**
- Consumes: `resolve-release-channel.mjs` CLI and its `version`, `npm_tag`, and `github_prerelease` outputs from Task 1.
- Produces: workflow environment values `RELEASE_TAG`, `RELEASE_VERSION`, `NPM_DIST_TAG`, and `GITHUB_PRERELEASE` in tag publication and recovery paths.
- Preserves: annotated-tag candidate inventory, checksum-bound npm reruns, Maven Central state recovery, public SwiftPM smoke tests, and API 26/API 35 Maven consumer tests.

- [ ] **Step 1: Replace hard-coded workflow assertions with channel invariants**

Update `release_workflow_publishes_android_through_a_recoverable_central_deployment` in `tools/xtask/tests/release_readiness.rs` to assert:

```rust
assert!(contents.contains("resolve-release-channel.mjs"));
assert!(contents.contains("--mode new"));
assert!(contents.contains("--mode recovery"));
assert!(contents.contains("--tag \"$NPM_DIST_TAG\""));
assert!(contents.contains("LATEST_BEFORE"));
assert!(contents.contains("test \"$LATEST_AFTER\" = \"$LATEST_BEFORE\""));
assert!(contents.contains("test \"$PUBLISHED_BETA\" = \"$RELEASE_VERSION\""));
assert!(contents.contains("gh release edit \"$RELEASE_TAG\" --draft=false --prerelease"));
assert!(!contents.contains("central-dev.bota-bota-android-sdk-1.1.0"));
assert!(!contents.contains("--version 1.1.0"));
assert!(!contents.contains("refs/tags/v1.1.0"));
assert!(!contents.contains("PACKAGE_SPEC=\"@bota.dev/react-native-sdk@1.1.0\""));
```

Add a separate test:

```rust
#[test]
fn release_workflow_never_publishes_npm_without_the_beta_tag() {
    let contents = fs::read_to_string(root().join(".github/workflows/release.yml")).unwrap();
    let npm_publish_lines = contents
        .lines()
        .filter(|line| line.contains("npm@$NPM_CLI_VERSION") && line.contains(" publish "))
        .collect::<Vec<_>>();
    assert_eq!(npm_publish_lines.len(), 1);
    for line in npm_publish_lines {
        assert!(line.contains("--tag \"$NPM_DIST_TAG\""), "{line}");
    }
}
```

- [ ] **Step 2: Run the focused Rust test and confirm it fails on current hard-coding**

Run:

```bash
cargo test -p xtask --test release_readiness \
  release_workflow_publishes_android_through_a_recoverable_central_deployment \
  -- --exact
```

Expected: FAIL because the workflow still contains the `1.1.0` deployment name and bare npm publish.

- [ ] **Step 3: Resolve and validate release metadata at workflow entry**

In the push `verify` job, add this before `cargo xtask release verify-tag`:

```yaml
- name: Resolve beta release channel
  run: |
    node tools/release/resolve-release-channel.mjs \
      --ref "$GITHUB_REF" \
      --mode new
```

Use a dynamic concurrency key:

```yaml
concurrency:
  group: app-sdk-release-${{ github.event_name == 'push' && github.ref_name || inputs.releaseRef }}
  cancel-in-progress: false
```

- [ ] **Step 4: Derive publication values once in the protected publish job**

Add this after repository dependencies are installed:

```yaml
- name: Resolve publication channel
  id: release-channel
  run: |
    node tools/release/resolve-release-channel.mjs \
      --ref "$GITHUB_REF" \
      --mode new \
      --github-output "$GITHUB_OUTPUT"

- name: Export publication metadata
  run: |
    {
      echo "RELEASE_TAG=$GITHUB_REF_NAME"
      echo "RELEASE_VERSION=${{ steps.release-channel.outputs.version }}"
      echo "NPM_DIST_TAG=${{ steps.release-channel.outputs.npm_tag }}"
      echo "GITHUB_PRERELEASE=${{ steps.release-channel.outputs.github_prerelease }}"
    } >> "$GITHUB_ENV"
```

Immediately compare `RELEASE_VERSION` with `${GITHUB_REF_NAME#v}` and require `NPM_DIST_TAG=beta` and `GITHUB_PRERELEASE=true`. Fail before signing or publishing on disagreement.

- [ ] **Step 5: Replace every publication-path `1.1.0` literal**

Within shell blocks, replace Central normalization, AAR comparison, Central bundle, npm package specification, release asset, and recovery artifact paths with `RELEASE_VERSION` and `RELEASE_TAG`. The Central deployment name becomes:

```bash
DEPLOYMENT_NAME="central-dev.bota-bota-android-sdk-$RELEASE_VERSION"
```

Pass the exact value to Central tooling. Do not alter artifact contents, signing, checksums, or candidate inventory semantics.

- [ ] **Step 6: Publish npm only to beta and prove latest is unchanged**

Replace the npm publication block with:

```bash
PACKAGE_PATH="$(find target/react-native-release -maxdepth 1 -type f -name '*.tgz' -print -quit)"
test -n "$PACKAGE_PATH"
PACKAGE_SPEC="@bota.dev/react-native-sdk@$RELEASE_VERSION"
EXPECTED_SHASUM="$(sha1sum "$PACKAGE_PATH" | awk '{print $1}')"
LATEST_BEFORE="$(npx --yes "npm@$NPM_CLI_VERSION" view @bota.dev/react-native-sdk dist-tags.latest)"
[[ "$LATEST_BEFORE" =~ ^0\.0\.[0-9]+$ ]]

if PUBLISHED_SHASUM="$(npx --yes "npm@$NPM_CLI_VERSION" view "$PACKAGE_SPEC" dist.shasum 2>/dev/null)"; then
  test "$PUBLISHED_SHASUM" = "$EXPECTED_SHASUM"
else
  npx --yes "npm@$NPM_CLI_VERSION" publish "$PACKAGE_PATH" --access public --tag "$NPM_DIST_TAG"
fi

PUBLISHED_SHASUM=""
for attempt in {1..30}; do
  if PUBLISHED_SHASUM="$(npx --yes "npm@$NPM_CLI_VERSION" view "$PACKAGE_SPEC" dist.shasum 2>/dev/null)"; then
    break
  fi
  sleep 10
done
test "$PUBLISHED_SHASUM" = "$EXPECTED_SHASUM"
LATEST_AFTER="$(npx --yes "npm@$NPM_CLI_VERSION" view @bota.dev/react-native-sdk dist-tags.latest)"
PUBLISHED_BETA="$(npx --yes "npm@$NPM_CLI_VERSION" view @bota.dev/react-native-sdk dist-tags.beta)"
test "$LATEST_AFTER" = "$LATEST_BEFORE"
test "$PUBLISHED_BETA" = "$RELEASE_VERSION"
```

This intentionally makes historical recovery fail if the one-time `1.1.0` beta-tag migration has not happened; OIDC publication must not attempt a separate dist-tag mutation.

- [ ] **Step 7: Mark created and completed GitHub releases as prereleases**

Add `--prerelease` to `gh release create` and finish publication with:

```bash
gh release edit "$RELEASE_TAG" --draft=false --prerelease
```

- [ ] **Step 8: Generalize recovery without weakening identity checks**

After `recover-central` checks out protected tooling and runs `npm ci`, resolve the workflow input in a step with `id: release-channel`:

```bash
RELEASE_REF='${{ inputs.releaseRef }}'
node tools/release/resolve-release-channel.mjs \
  --ref "$RELEASE_REF" \
  --mode recovery \
  --github-output "$GITHUB_OUTPUT"
```

In the next step, export the values through `GITHUB_ENV`:

```yaml
- name: Export recovery metadata
  run: |
    RELEASE_REF='${{ inputs.releaseRef }}'
    RELEASE_TAG="${RELEASE_REF#refs/tags/}"
    {
      echo "RELEASE_REF=$RELEASE_REF"
      echo "RELEASE_TAG=$RELEASE_TAG"
      echo "RELEASE_VERSION=${{ steps.release-channel.outputs.version }}"
      echo "NPM_DIST_TAG=${{ steps.release-channel.outputs.npm_tag }}"
      echo "GITHUB_PRERELEASE=${{ steps.release-channel.outputs.github_prerelease }}"
    } >> "$GITHUB_ENV"
```

Replace all recovery literals with those values. Continue requiring:

```bash
test "$GITHUB_REF" = "refs/heads/main"
test "$(git cat-file -t "$RELEASE_TAG")" = tag
git merge-base --is-ancestor "$(git rev-list -n 1 "$RELEASE_TAG")" HEAD
cargo xtask release verify-tag "$RELEASE_TAG"
```

Download only artifacts from `inputs.releaseRunId`, regenerate the candidate inventory from those bytes, compare it to the release inventory, and retain exact Central deployment UUID checks. Historical `v1.1.0` recovery is allowed by `--mode recovery`; a new stable tag remains blocked by the push path.

- [ ] **Step 9: Run workflow and release-policy tests**

Run:

```bash
cargo test -p xtask --test release_readiness
npm run test:release
rg -n 'central-dev\.bota-bota-android-sdk-1\.1\.0|--version 1\.1\.0|refs/tags/v1\.1\.0|PACKAGE_SPEC=.*1\.1\.0' .github/workflows/release.yml
```

Expected: both test suites PASS; `rg` returns no matches and exits 1.

- [ ] **Step 10: Commit the protected workflow change**

```bash
git add .github/workflows/release.yml tools/xtask/tests/release_readiness.rs
git commit -m "build(release): publish App SDK through beta channel"
```

---

### Task 3: Build and verify immutable legacy `0.0.x` candidates

**Files:**
- Create: `scripts/release-candidate.mjs`
- Create: `scripts/release-candidate.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `createCandidateInventory({ tarballPath, packageJsonPath, sourceRevision, tag }): Promise<LegacyCandidateInventory>`.
- Produces: `writeCandidateInventory({ tarballPath, packageJsonPath, sourceRevision, tag, outputPath }): Promise<LegacyCandidateInventory>`.
- Produces: `verifyCandidateInventory({ tarballPath, inventoryPath }): Promise<void>`.
- Produces CLI create mode: `node scripts/release-candidate.mjs create --tarball <tgz> --package-json package.json --source-revision <40-hex> --tag v0.0.x --output <json>`.
- Produces CLI verify mode: `node scripts/release-candidate.mjs verify --tarball <tgz> --inventory <json>`.
- Inventory schema: `{ schemaVersion: 1, packageName, version, tag, sourceRevision, tarball: { fileName, byteLength, sha1, sha256 } }`.

- [ ] **Step 1: Write failing candidate integrity tests**

Create `scripts/release-candidate.test.mjs` with a real tar fixture and imports matching the production interface:

```js
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  createCandidateInventory,
  verifyCandidateInventory,
  writeCandidateInventory,
} from './release-candidate.mjs';

const execute = promisify(execFile);
const sourceRevision = 'a'.repeat(40);

async function makeFixture(t, {
  packageName = '@bota.dev/react-native-sdk',
  version = '0.0.66',
  tag = `v${version}`,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bota-legacy-candidate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archiveRoot = join(directory, 'archive');
  const packageDirectory = join(archiveRoot, 'package');
  const packageJsonPath = join(directory, 'package.json');
  const tarballPath = join(directory, 'bota.dev-react-native-sdk-0.0.66.tgz');
  const inventoryPath = join(directory, 'release-candidate.json');
  const packageJson = `${JSON.stringify({ name: packageName, version })}\n`;
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(packageJsonPath, packageJson);
  await writeFile(join(packageDirectory, 'package.json'), packageJson);
  await writeFile(join(packageDirectory, 'index.js'), 'export {};\n');
  await execute('tar', ['-czf', tarballPath, '-C', archiveRoot, 'package']);
  return {
    inventoryPath,
    packageJsonPath,
    sourceRevision,
    tag,
    tarballPath,
  };
}
```

The success test computes expected values from the actual fixture bytes:

```js
test('writes and verifies a deterministic legacy candidate inventory', async (t) => {
  const fixture = await makeFixture(t);
  const contents = await readFile(fixture.tarballPath);
  const tarballStat = await stat(fixture.tarballPath);
  const inventory = await writeCandidateInventory({ ...fixture, outputPath: fixture.inventoryPath });

assert.deepEqual(inventory, {
  schemaVersion: 1,
  packageName: '@bota.dev/react-native-sdk',
  version: '0.0.66',
  tag: 'v0.0.66',
  sourceRevision: 'a'.repeat(40),
  tarball: {
    fileName: 'bota.dev-react-native-sdk-0.0.66.tgz',
    byteLength: tarballStat.size,
    sha1: createHash('sha1').update(contents).digest('hex'),
    sha256: createHash('sha256').update(contents).digest('hex'),
  },
});

  const first = await readFile(fixture.inventoryPath, 'utf8');
  await writeCandidateInventory({ ...fixture, outputPath: fixture.inventoryPath });
  assert.equal(await readFile(fixture.inventoryPath, 'utf8'), first);
  await verifyCandidateInventory({
    tarballPath: fixture.tarballPath,
    inventoryPath: fixture.inventoryPath,
  });
});
```

Add exact negative tests without helper names that production does not define:

```js
test('rejects non-maintenance versions, mismatched tags, and package names', async (t) => {
  const wrongVersion = await makeFixture(t, { version: '0.1.0' });
  await assert.rejects(
    createCandidateInventory(wrongVersion),
    /legacy version must match 0\.0\.x/,
  );
  const wrongTag = await makeFixture(t, { tag: 'v0.0.67' });
  await assert.rejects(
    createCandidateInventory(wrongTag),
    /tag must equal v0\.0\.66/,
  );
  const wrongPackage = await makeFixture(t, { packageName: '@example/sdk' });
  await assert.rejects(
    createCandidateInventory(wrongPackage),
    /unexpected package name/,
  );
});

test('rejects a tarball changed after inventory generation', async (t) => {
  const fixture = await makeFixture(t);
  await writeCandidateInventory({ ...fixture, outputPath: fixture.inventoryPath });
  await appendFile(fixture.tarballPath, 'changed');
  await assert.rejects(
    verifyCandidateInventory({
      tarballPath: fixture.tarballPath,
      inventoryPath: fixture.inventoryPath,
    }),
    /SHA-256 mismatch/,
  );
});
```

- [ ] **Step 2: Run the candidate tests and confirm the missing module failure**

Run:

```bash
node --test scripts/release-candidate.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `release-candidate.mjs`.

- [ ] **Step 3: Implement candidate creation**

Use Node standard library modules. Read both the repository `package.json` and `package/package.json` from the `.tgz` with `tar -xOf`; require both to contain the exact package name and version. Validate the source revision with `/^[0-9a-f]{40}$/`, version with `/^0\.0\.[0-9]+$/`, and tag equality with `v${version}`. Compute hashes from tarball bytes:

```js
const sha1 = createHash('sha1').update(contents).digest('hex');
const sha256 = createHash('sha256').update(contents).digest('hex');
```

Serialize the inventory in the property order shown above, with two-space indentation and one trailing newline. Write through a same-directory temporary file and `rename` so interruption cannot leave partial inventory.

- [ ] **Step 4: Implement candidate verification**

`verifyCandidateInventory` validates schema version, package name, `0.0.x` version, tag equality, 40-character source revision, basename equality, byte length, SHA-1, and SHA-256. It accepts one exact tarball path instead of scanning a directory.

- [ ] **Step 5: Add package scripts**

Add:

```json
"release:candidate": "node scripts/release-candidate.mjs",
"test:release": "node --test scripts/release-candidate.test.mjs"
```

- [ ] **Step 6: Verify candidate tests and normal SDK gates**

Run:

```bash
node --test scripts/release-candidate.test.mjs
npm run typecheck
npm test -- --runInBand
```

Expected: all commands PASS.

- [ ] **Step 7: Commit candidate tooling in the legacy repository**

```bash
git add scripts/release-candidate.mjs scripts/release-candidate.test.mjs package.json
git commit -m "build(release): create immutable legacy candidates"
```

---

### Task 4: Replace legacy automatic publication with a candidate-only workflow

**Files:**
- Modify: `.github/workflows/publish.yml`
- Create: `scripts/release-workflow.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: candidate create/verify CLI from Task 3.
- Produces: GitHub Actions artifact `legacy-react-native-${{ github.ref_name }}-${{ github.sha }}` containing one `.tgz` and `release-candidate.json`.
- Removes: automated npm publication, OIDC permission, release-event duplicate trigger, and every npm write-token path.

- [ ] **Step 1: Add failing static workflow policy tests**

Create `scripts/release-workflow.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../.github/workflows/publish.yml', import.meta.url);

test('legacy workflow builds candidates but cannot publish', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(workflow, /tags:\s*\n\s*- ['"]v0\.0\.\*['"]/);
  assert.doesNotMatch(workflow, /\brelease:\s*\n/);
  assert.doesNotMatch(workflow, /id-token:\s*write/);
  assert.doesNotMatch(workflow, /npm(?:@[^"'\s]+)?["']?\s+publish\b/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/);
  assert.match(workflow, /npm run license-check/);
  assert.match(workflow, /release-candidate\.mjs create/);
  assert.match(workflow, /release-candidate\.mjs verify/);
  assert.match(workflow, /actions\/upload-artifact@/);
});

test('legacy workflow uses an exact pinned npm CLI', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(workflow, /NPM_CLI_VERSION: ['"]12\.0\.2['"]/);
  assert.match(workflow, /npx --yes "npm@\$NPM_CLI_VERSION" pack/);
});
```

- [ ] **Step 2: Run the workflow test and confirm current publication fails policy**

Run:

```bash
node --test scripts/release-workflow.test.mjs
```

Expected: FAIL because the current workflow has `id-token: write`, a release trigger, and `npm publish`.

- [ ] **Step 3: Convert `.github/workflows/publish.yml` to a candidate builder**

Use this workflow shape:

```yaml
name: Build legacy React Native SDK candidate

on:
  push:
    tags:
      - 'v0.0.*'

permissions:
  contents: read

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'
  NPM_CLI_VERSION: '12.0.2'

jobs:
  candidate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v7
        with:
          node-version: '24'
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test -- --runInBand
      - run: npm run build
      - run: npm run license-check
```

Add an identity step requiring an annotated tag and a commit on `origin/main`:

```bash
test "$(git cat-file -t "$GITHUB_REF_NAME")" = tag
SOURCE_REVISION="$(git rev-list -n 1 "$GITHUB_REF_NAME")"
test "$SOURCE_REVISION" = "$(git rev-parse HEAD)"
git merge-base --is-ancestor "$SOURCE_REVISION" origin/main
test "$GITHUB_REF_NAME" = "v$(node -p 'require("./package.json").version')"
echo "SOURCE_REVISION=$SOURCE_REVISION" >> "$GITHUB_ENV"
```

- [ ] **Step 4: Pack, inventory, and verify one exact artifact**

Add:

```bash
set -euo pipefail
mkdir -p target/release-candidate
mkdir -p target/release-replay
npx --yes "npm@$NPM_CLI_VERSION" pack --json \
  --pack-destination target/release-candidate \
  > target/npm-pack-first.json
npx --yes "npm@$NPM_CLI_VERSION" pack --json \
  --pack-destination target/release-replay \
  > target/npm-pack-second.json
PACKAGE_FILE="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync("target/npm-pack-first.json","utf8")); if(p.length!==1) process.exit(1); process.stdout.write(p[0].filename)')"
PACKAGE_BASENAME="$(basename "$PACKAGE_FILE")"
PACKAGE_PATH="target/release-candidate/$PACKAGE_BASENAME"
test -f "$PACKAGE_PATH"
cmp "$PACKAGE_PATH" "target/release-replay/$PACKAGE_BASENAME"
node scripts/release-candidate.mjs create \
  --tarball "$PACKAGE_PATH" \
  --package-json package.json \
  --source-revision "$SOURCE_REVISION" \
  --tag "$GITHUB_REF_NAME" \
  --output target/release-candidate/release-candidate.json
node scripts/release-candidate.mjs verify \
  --tarball "$PACKAGE_PATH" \
  --inventory target/release-candidate/release-candidate.json
test "$(find target/release-candidate -maxdepth 1 -name '*.tgz' | wc -l | tr -d ' ')" = 1
rm -rf target/release-replay target/npm-pack-first.json target/npm-pack-second.json
```

Upload `target/release-candidate/` with `if-no-files-found: error` and `compression-level: 0`. Do not add a registry URL or npm authentication environment variable.

- [ ] **Step 5: Add the workflow test to the release gate**

Change the package script to:

```json
"test:release": "node --test scripts/release-candidate.test.mjs scripts/release-workflow.test.mjs"
```

- [ ] **Step 6: Run release and package verification locally**

Run:

```bash
npm run test:release
npm run typecheck
npm run lint
npm test -- --runInBand
npm run build
npm run license-check
```

Expected: every command PASS.

- [ ] **Step 7: Prove automatic publishing is absent**

Run:

```bash
rg -n 'npm publish|NODE_AUTH_TOKEN|NPM_TOKEN|id-token: write|release:' .github/workflows/publish.yml
```

Expected: no matches; command exits 1.

- [ ] **Step 8: Commit the candidate-only workflow**

```bash
git add .github/workflows/publish.yml scripts/release-workflow.test.mjs package.json
git commit -m "ci(release): stop automatic legacy npm publication"
```

---

### Task 5: Document consumer channels and manual maintenance publication

**Files:**
- Create: `react-native-sdk/PUBLISHING.md`
- Modify: `react-native-sdk/README.md`
- Modify: `react-native-sdk/AGENTS.md`
- Modify: `react-native-sdk/ARCHITECTURE.md`
- Modify: `app-sdk/README.md`
- Modify: `app-sdk/docs/releasing.md`
- Modify: `docs/api-reference/client-sdks.mdx`
- Modify: `docs/changelog.mdx` (release-channel hunk only; preserve the existing encrypted-upload entry)
- Modify: `internal-docs/App SDK Architecture.md`

**Interfaces:**
- Consumes: policy, workflow, and inventory commands from Tasks 1 through 4.
- Produces: one public install contract and one exact maintainer runbook.
- Preserves: untagged install for legacy production consumers and exact `1.1.0` pins in Demo and Bota One.

- [ ] **Step 1: Write the legacy maintainer runbook**

Create `react-native-sdk/PUBLISHING.md` with these phases:

1. Update `package.json` and `package-lock.json` to the same new `0.0.x` version.
2. Merge the reviewed commit to `main`, then create an annotated `v0.0.x` tag on that exact commit.
3. Download the `legacy-react-native-v0.0.x-<commit>` workflow artifact.
4. Verify before authentication:

```bash
PACKAGE_PATH="$(find . -maxdepth 1 -name '*.tgz' -print -quit)"
node scripts/release-candidate.mjs verify \
  --tarball "$PACKAGE_PATH" \
  --inventory release-candidate.json
BETA_BEFORE="$(npx --yes npm@12.0.2 view @bota.dev/react-native-sdk dist-tags.beta)"
```

5. Publish only the downloaded tarball from an interactive WebAuthn-protected npm session:

```bash
npx --yes npm@12.0.2 publish "$PACKAGE_PATH" --access public --tag latest
```

6. Verify immutable bytes and both channel pointers:

```bash
VERSION="$(node -p 'require("./release-candidate.json").version')"
EXPECTED_SHA1="$(node -p 'require("./release-candidate.json").tarball.sha1')"
PUBLISHED_SHA1="$(npx --yes npm@12.0.2 view "@bota.dev/react-native-sdk@$VERSION" dist.shasum)"
LATEST_AFTER="$(npx --yes npm@12.0.2 view @bota.dev/react-native-sdk dist-tags.latest)"
BETA_AFTER="$(npx --yes npm@12.0.2 view @bota.dev/react-native-sdk dist-tags.beta)"
test "$PUBLISHED_SHA1" = "$EXPECTED_SHA1"
test "$LATEST_AFTER" = "$VERSION"
test "$BETA_AFTER" = "$BETA_BEFORE"
```

Document that an existing version with the same hash is complete, a different hash is a hard stop, and no one rebuilds after tagging.

- [ ] **Step 2: Update public consumer guidance**

Keep the legacy README default install unchanged:

```bash
npm install @bota.dev/react-native-sdk react-native-ble-plx
```

Add a channel note that this resolves the production `0.0.x` maintenance line. In `app-sdk/README.md`, make beta installation explicit:

```bash
npm install @bota.dev/react-native-sdk@beta
```

State that Apple and Android beta consumers pin the exact synchronized prerelease because SwiftPM and Maven Central do not use npm dist-tags.

Update `docs/api-reference/client-sdks.mdx` so the public page distinguishes both React Native commands:

```bash
# Production maintenance line (currently 0.0.65)
npm install @bota.dev/react-native-sdk

# Synchronized App SDK beta (currently 1.1.0)
npm install @bota.dev/react-native-sdk@beta
```

Replace the obsolete statement that native SDKs are unpublished with exact beta installation guidance:

```swift
.package(url: "https://github.com/bota-dev/app-sdk.git", exact: "1.1.0")
```

```kotlin
implementation("dev.bota:bota-android-sdk:1.1.0")
```

Label both native coordinates beta and link their source/release notes to `https://github.com/bota-dev/app-sdk`.

- [ ] **Step 3: Update repository architecture and release instructions**

In clean legacy documentation, record that CI builds checksum-bound candidates and a maintainer publishes the exact artifact interactively. In App SDK `docs/releasing.md`, replace stable/bare npm wording with beta-tag publication, prerelease GitHub releases, dynamic recovery refs, and the `1.2.0-beta.0` next-release rule.

Do not modify or stage `app-sdk/AGENTS.md` or `app-sdk/ARCHITECTURE.md`; their pre-existing worktree changes are outside this implementation. Their current synchronized-version and OIDC authority statements remain valid.

- [ ] **Step 4: Update the cross-system architecture record**

In `docs/changelog.mdx`, add a `2026-09-02` item titled **SDK Beta and Maintenance Channels** before the existing encrypted-upload item. State that untagged React Native installs resolve the maintained `0.0.x` line, `@beta` selects the synchronized App SDK, and native consumers use exact beta versions. Keep the pre-existing encrypted-upload text byte-for-byte.

In `internal-docs/App SDK Architecture.md`, add:

| SDK line | Source | Version | Distribution channel |
|---|---|---|---|
| React Native maintenance | `react-native-sdk` | `0.0.x` | npm `latest` |
| Synchronized App SDK beta | `app-sdk` | `1.x.y-beta.n` | npm `beta`, exact SwiftPM/Maven version |

Record that future Bota API SDKs are a separate family and stable App SDK promotion is an explicit product/release decision.

- [ ] **Step 5: Search the complete documentation surface for stale language**

Run from the workspace root:

```bash
rg -n 'npm publish|@bota\.dev/react-native-sdk|1\.1\.0|0\.0\.65|dist-tag|prerelease' \
  app-sdk react-native-sdk internal-docs docs \
  -g '*.md' -g 'AGENTS.md' -g 'ARCHITECTURE.md' -g 'README.md'
```

Review every hit. Historical release evidence may retain exact commands and versions when clearly labeled historical; current instructions must reflect approved channel ownership. Then run the public docs site with Node 22 and load `/api-reference/client-sdks`:

```bash
nvm use 22
mint dev
```

Expected: Mint starts successfully and the client SDK page renders both channel commands and both native beta coordinates.

- [ ] **Step 6: Commit documentation separately in each repository**

Legacy repository:

```bash
git add PUBLISHING.md README.md AGENTS.md ARCHITECTURE.md
git commit -m "docs(release): document legacy maintenance publishing"
```

App SDK repository:

```bash
git add README.md docs/releasing.md
git commit -m "docs(release): document beta distribution"
```

Internal docs repository:

```bash
git add 'App SDK Architecture.md'
git commit -m "docs(sdk): record release channel migration"
```

Public docs repository:

```bash
git add api-reference/client-sdks.mdx
git add -p changelog.mdx
git diff --cached --check
git diff --cached -- api-reference/client-sdks.mdx changelog.mdx
git commit -m "docs(sdk): document beta and maintenance channels"
```

At the `git add -p` prompt, stage only the **SDK Beta and Maintenance Channels** addition. Leave the pre-existing **Encrypted Upload v2 Backend Foundation** addition unstaged. If Git cannot split the additions into separate hunks, leave `changelog.mdx` unstaged and commit `api-reference/client-sdks.mdx`; do not absorb the unrelated changelog work.

Before each commit, run `git diff --cached --check` and inspect `git diff --cached`. In `app-sdk`, confirm `AGENTS.md` and `ARCHITECTURE.md` remain unstaged.

---

### Task 6: Migrate existing npm and GitHub pointers without changing artifacts

**Files:**
- Modify: `app-sdk/release/evidence/1.1.0-react-native.md`
- Verify only: `demo/app/package.json`, `demo/package-lock.json`
- Verify only: `bota-one/app/package.json`, `bota-one/package-lock.json`

**Interfaces:**
- Consumes: authenticated npm maintainer session and GitHub CLI access.
- Produces: npm `latest=0.0.65`, npm `beta=1.1.0`, and GitHub `v1.1.0` prerelease status.
- Preserves: npm `0.0.65` and `1.1.0` tarball hashes, Maven `1.1.0`, SwiftPM `v1.1.0`, and both app lockfiles.

- [ ] **Step 1: Capture the immutable pre-migration state**

Run:

```bash
npx --yes npm@12.0.2 view @bota.dev/react-native-sdk dist-tags --json
npx --yes npm@12.0.2 view @bota.dev/react-native-sdk@0.0.65 dist.shasum
npx --yes npm@12.0.2 view @bota.dev/react-native-sdk@1.1.0 dist.shasum
gh release view v1.1.0 --repo bota-dev/app-sdk --json tagName,isPrerelease,isDraft,url
```

Record both SHA-1 values. The expected `1.1.0` value from existing evidence is `500817b2ae66317fb92caa071772db1840155fbc`; stop if the registry differs.

- [ ] **Step 2: Move npm dist-tags in the authenticated maintainer session**

Run sequentially so WebAuthn can complete:

```bash
npx --yes npm@12.0.2 dist-tag add @bota.dev/react-native-sdk@0.0.65 latest
npx --yes npm@12.0.2 dist-tag add @bota.dev/react-native-sdk@1.1.0 beta
```

Do not remove versions and do not run `npm publish`.

- [ ] **Step 3: Mark the existing GitHub release as a prerelease**

Run:

```bash
gh release edit v1.1.0 --repo bota-dev/app-sdk --prerelease
```

- [ ] **Step 4: Verify registry pointers, hashes, and GitHub status**

Run:

```bash
test "$(npx --yes npm@12.0.2 view @bota.dev/react-native-sdk dist-tags.latest)" = 0.0.65
test "$(npx --yes npm@12.0.2 view @bota.dev/react-native-sdk dist-tags.beta)" = 1.1.0
test "$(npx --yes npm@12.0.2 view @bota.dev/react-native-sdk@1.1.0 dist.shasum)" = 500817b2ae66317fb92caa071772db1840155fbc
gh release view v1.1.0 --repo bota-dev/app-sdk --json isPrerelease --jq '.isPrerelease' | grep -Fx true
```

Expected: all four checks PASS.

- [ ] **Step 5: Prove Demo and Bota One remain exact beta-acceptance consumers**

Run:

```bash
node -e 'const p=require("./demo/app/package.json"); if(p.dependencies["@bota.dev/react-native-sdk"]!=="1.1.0") process.exit(1)'
node -e 'const p=require("./bota-one/app/package.json"); if(p.dependencies["@bota.dev/react-native-sdk"]!=="1.1.0") process.exit(1)'
rg -n 'react-native-sdk-1\.1\.0\.tgz' demo/package-lock.json bota-one/package-lock.json
git -C demo diff --exit-code -- app/package.json package-lock.json
git -C bota-one diff --exit-code -- app/package.json package-lock.json
```

Expected: both package checks and lockfile matches succeed; both `git diff` commands are empty.

- [ ] **Step 6: Record the operational reclassification**

Update `release/evidence/1.1.0-react-native.md` to state:

- `1.1.0` remains immutable and is the current npm `beta` target.
- `0.0.65` is restored as npm `latest`.
- GitHub release `v1.1.0` is a prerelease.
- Demo and Bota One continue exact `1.1.0` acceptance pins.
- Include verification date `2026-09-02` and both unchanged registry SHA-1 values.

- [ ] **Step 7: Commit the updated release evidence**

```bash
git add release/evidence/1.1.0-react-native.md
git commit -m "docs(release): record beta channel migration"
```

---

### Task 7: Run full gates, audit diffs, and push each repository

**Files:**
- Verify all files changed in Tasks 1 through 6.
- No new production files.

**Interfaces:**
- Consumes: committed App SDK, legacy React Native SDK, and internal documentation changes.
- Produces: pushed `main` branches with no accidental app dependency changes and externally verified release channels.

- [ ] **Step 1: Run complete App SDK release and tooling gates**

Run:

```bash
cd /Users/zhangqi/ws/bota/app-sdk
npm run test:release
npm run test:tooling
cargo test -p xtask --test release_readiness
cargo xtask release verify-tag v1.1.0
```

Expected: all commands PASS. `verify-tag v1.1.0` remains valid as historical immutable release verification; new-release rejection is exercised by channel-policy tests.

- [ ] **Step 2: Run complete legacy React Native SDK gates**

Run:

```bash
cd /Users/zhangqi/ws/bota/react-native-sdk
npm run test:release
npm run typecheck
npm run lint
npm test -- --runInBand
npm run build
npm run license-check
```

Expected: all commands PASS.

- [ ] **Step 3: Audit workflow security and channel ownership**

Run:

```bash
rg -n 'npm publish|NODE_AUTH_TOKEN|NPM_TOKEN|id-token: write' \
  /Users/zhangqi/ws/bota/react-native-sdk/.github/workflows/publish.yml
rg -n 'publish .*--tag "\$NPM_DIST_TAG"|dist-tags\.latest|dist-tags\.beta|--prerelease' \
  /Users/zhangqi/ws/bota/app-sdk/.github/workflows/release.yml
```

Expected: legacy search has no matches; App SDK search shows beta-tag publication, both dist-tag checks, and prerelease handling.

- [ ] **Step 4: Audit repository state**

Run:

```bash
git -C /Users/zhangqi/ws/bota/app-sdk status --short --branch
git -C /Users/zhangqi/ws/bota/react-native-sdk status --short --branch
git -C /Users/zhangqi/ws/bota/internal-docs status --short --branch
git -C /Users/zhangqi/ws/bota/docs status --short --branch
git -C /Users/zhangqi/ws/bota/demo status --short --branch
git -C /Users/zhangqi/ws/bota/bota-one status --short --branch
```

Expected: implementation files are committed; App SDK's pre-existing `AGENTS.md` and `ARCHITECTURE.md` changes remain unstaged and preserved; Demo and Bota One have no changes from this work.

- [ ] **Step 5: Re-verify public channel state before push**

Run:

```bash
npx --yes npm@12.0.2 view @bota.dev/react-native-sdk dist-tags --json
gh release view v1.1.0 --repo bota-dev/app-sdk --json tagName,isPrerelease,isDraft,url
```

Expected: npm reports `latest: 0.0.65` and `beta: 1.1.0`; GitHub reports `isPrerelease: true` and `isDraft: false`.

- [ ] **Step 6: Push the four committed main branches**

Run:

```bash
git -C /Users/zhangqi/ws/bota/react-native-sdk push origin main
git -C /Users/zhangqi/ws/bota/internal-docs push origin main
git -C /Users/zhangqi/ws/bota/docs push origin main
git -C /Users/zhangqi/ws/bota/app-sdk push origin main
```

Expected: each push succeeds without force. App SDK pushes only committed release-channel work; preserved local documentation edits in App SDK, public docs, and internal docs remain local.

- [ ] **Step 7: Inspect GitHub Actions without triggering a release**

Run:

```bash
gh run list --repo bota-dev/react-native-sdk --branch main --limit 5
gh run list --repo bota-dev/app-sdk --branch main --limit 5
```

Expected: normal branch CI may run; neither tag-only release workflow starts because this plan creates no release tag.

---

## Completion Criteria

- `npm install @bota.dev/react-native-sdk` resolves `0.0.65` through `latest`.
- `npm install @bota.dev/react-native-sdk@beta` resolves `1.1.0`.
- App SDK workflow rejects a new stable tag, publishes future prereleases with `--tag beta`, preserves `latest`, and marks GitHub releases as prereleases.
- Historical `v1.1.0` Central recovery remains exact-version and checksum bound.
- Legacy `v0.0.x` workflow produces one verified candidate and has no path to npm publication.
- Manual legacy publication verifies the exact tarball SHA-1 and preserves `beta`.
- Demo and Bota One remain unchanged on exact `1.1.0` lockfiles.
- The next synchronized version is documented as `1.2.0-beta.0`, but no new release is tagged or published by this implementation.
