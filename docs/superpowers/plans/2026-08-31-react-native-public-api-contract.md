# React Native Public API Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the production `@bota.dev/react-native-sdk` 0.0.65 TypeScript API as a semantic, machine-verifiable contract before the monorepo React Native implementation begins.

**Architecture:** A TypeScript Compiler API tool loads the pinned SDK's `tsconfig.build.json`, resolves the root `src/index.ts` module, and serializes every exported symbol plus its reachable public surface into a canonical JSON contract. The existing baseline comparator verifies the pinned source revision against that committed contract; future `frameworks/react-native` builds must compare equal before Demo or Bota One can migrate.

**Tech Stack:** Node.js 22+, TypeScript 6.0.3 Compiler API, Node test runner, SHA-256, existing React Native baseline workflow.

**Spec:** `docs/superpowers/plans/2026-08-28-app-sdk-implementation.md` Milestone 4 and `ARCHITECTURE.md` Migration Rule.

## Global Constraints

- `@bota.dev/react-native-sdk` at revision `44ac1221cb71eb01cafcdbfdf7a370847d3a10b4` and version `0.0.65` remains authoritative.
- Capture only symbols reachable from `src/index.ts`; internal modules are not public merely because declarations exist.
- Include expanded type aliases, public class static members, and inherited
  public members reachable through exported class instances; exclude private,
  protected, and internal-only declarations.
- Normalize all paths to repository-relative POSIX paths and sort every symbol/member list before hashing.
- Contract comparison ignores source revision and package version but requires an exact `surfaceDigest` match.
- This milestone does not publish a React Native package or claim Apple/Android runtime parity.
- Every commit includes `Co-Authored-By: OpenAI Codex <noreply@openai.com>`.

---

### Task 1: Semantic API Extractor

**Files:**
- Create: `tools/baseline/react-native-api-contract.mjs`
- Create: `tools/baseline/react-native-api-contract.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: an SDK root containing `package.json`, `tsconfig.build.json`, and `src/index.ts`.
- Produces: `extractReactNativeApi(sdkPath): ReactNativeApiSurface` and `surfaceDigest(surface): string`.

`ReactNativeApiSurface` has this exact JSON shape:

```ts
interface ReactNativeApiSurface {
  exports: Array<{
    name: string;
    runtime: boolean;
    declarationKinds: string[];
    valueType?: string;
    declaredType?: string;
    callSignatures: string[];
    constructSignatures: string[];
    members: Array<{
      name: string;
      optional: boolean;
      readonly: boolean;
      declarationKinds: string[];
      type: string;
    }>;
    staticMembers: Array<{
      name: string;
      optional: boolean;
      readonly: boolean;
      declarationKinds: string[];
      type: string;
    }>;
  }>;
}
```

- [x] **Step 1: Add TypeScript 6.0.3 as a root development dependency**

Run:

```bash
npm install --save-dev --save-exact typescript@6.0.3
```

Expected: `package.json` and `package-lock.json` contain exactly `"typescript": "6.0.3"`.

- [x] **Step 2: Write extractor tests first**

Create a temporary TypeScript package with an exported class, an exported singleton whose inferred type is a non-exported class, an exported type alias, a static factory, a private method, and a dependency-owned base-class member. Assert that output is sorted, includes runtime/type-only identity, expands the alias, includes static and inherited public members, excludes private members, and yields the same digest twice.

- [x] **Step 3: Run the test and verify it fails**

Run:

```bash
node --test tools/baseline/react-native-api-contract.test.mjs
```

Expected: FAIL because `react-native-api-contract.mjs` does not exist.

- [x] **Step 4: Implement the extractor**

Use `ts.readConfigFile`, `ts.parseJsonConfigFileContent`, `ts.createProgram`, and `checker.getExportsOfModule`. Resolve aliases with `checker.getAliasedSymbol`; render normal types with `TypeFormatFlags.NoTruncation | TypeFormatFlags.UseAliasDefinedOutsideCurrentScope`, and add `TypeFormatFlags.InTypeAlias` for aliases. Identify SDK-owned declarations by checking that their normalized path is under `<sdkPath>/src/`, while retaining inherited public class members that are reachable from an export.

- [x] **Step 5: Run the focused and tooling tests**

Run:

```bash
node --test tools/baseline/react-native-api-contract.test.mjs
npm run test:tooling
```

Expected: PASS.

- [x] **Step 6: Commit the extractor**

```bash
git add package.json package-lock.json tools/baseline/react-native-api-contract.mjs tools/baseline/react-native-api-contract.test.mjs
git commit -m "feat(baseline): extract React Native public API contract" -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 2: Frozen 0.0.65 Contract

**Files:**
- Create: `protocol/baseline/react-native-public-api-0.0.65.json`
- Modify: `protocol/baseline/react-native-sdk-0.0.65.json`
- Modify: `tools/baseline/react-native-api-contract.mjs`
- Modify: `tools/baseline/react-native-api-contract.test.mjs`

**Interfaces:**
- Consumes: `extractReactNativeApi()` from Task 1 and the pinned clean SDK checkout.
- Produces: `buildReactNativeApiContract(options): ReactNativeApiContract`, `writeReactNativeApiContract(options): void`, and `verifyReactNativeApiContract(options): void`.

The committed contract wraps the surface in this exact envelope:

```ts
interface ReactNativeApiContract {
  schemaVersion: 1;
  package: "@bota.dev/react-native-sdk";
  packageVersion: "0.0.65";
  sourceRevision: "44ac1221cb71eb01cafcdbfdf7a370847d3a10b4";
  entrypoint: "src/index.ts";
  surfaceDigest: string;
  surface: ReactNativeApiSurface;
}
```

- [x] **Step 1: Add failing contract-envelope and comparison tests**

Tests must reject a dirty checkout unless `allowDirty` is true, reject package/revision drift during capture, and report added, removed, or changed export names when a supplied contract digest differs.

- [x] **Step 2: Run the tests and verify failure**

Run:

```bash
node --test tools/baseline/react-native-api-contract.test.mjs
```

Expected: FAIL because the contract functions and CLI do not exist.

- [x] **Step 3: Implement capture and verify CLI modes**

Support these exact commands:

```bash
node tools/baseline/react-native-api-contract.mjs capture \
  --sdk-path PATH --expected-commit SHA --expected-version VERSION --output FILE
node tools/baseline/react-native-api-contract.mjs verify \
  --sdk-path PATH --contract FILE
```

Capture refuses dirty input and writes canonical two-space JSON with a final newline. Verify compares semantic surface only, so a future synchronized package version can prove API compatibility.

- [x] **Step 4: Capture from a clean 0.0.65 worktree**

Run against a clean worktree at `44ac1221cb71eb01cafcdbfdf7a370847d3a10b4`, not the user's dirty production checkout.

- [x] **Step 5: Record the digest in the existing baseline metadata**

Add a `publicApi` object whose `contract` is
`protocol/baseline/react-native-public-api-0.0.65.json` and whose
`surfaceDigest` is the exact 64-character lowercase SHA-256 emitted by the
capture command. The metadata and contract values must be byte-for-byte equal.

- [x] **Step 6: Verify the committed contract**

Run:

```bash
SDK_BASELINE=${SDK_BASELINE:?set SDK_BASELINE to a clean 0.0.65 checkout}
node tools/baseline/react-native-api-contract.mjs verify \
  --sdk-path "$SDK_BASELINE" \
  --contract protocol/baseline/react-native-public-api-0.0.65.json
```

Expected: PASS and print the package, export count, and digest.

- [x] **Step 7: Commit the frozen contract**

```bash
git add protocol/baseline/react-native-public-api-0.0.65.json protocol/baseline/react-native-sdk-0.0.65.json tools/baseline/react-native-api-contract.mjs tools/baseline/react-native-api-contract.test.mjs
git commit -m "test(baseline): freeze React Native 0.0.65 API" -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 3: Baseline Workflow Enforcement

**Files:**
- Modify: `tools/baseline/compare-react-native.mjs`
- Modify: `tools/baseline/compare-react-native.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `verifyReactNativeApiContract()` and the existing protocol/Jest baseline comparison.
- Produces: one `npm run baseline:react-native` command that fails on protocol, workflow-test-count, source-digest, or public-API drift.

- [x] **Step 1: Add a failing comparator integration test**

Inject a contract verifier into `compareReactNative()` and assert it receives the same SDK path plus `protocol/baseline/react-native-public-api-0.0.65.json`. Assert a verifier failure aborts before fixture execution.

- [x] **Step 2: Run the focused comparator test and verify failure**

```bash
node --test tools/baseline/compare-react-native.test.mjs
```

Expected: FAIL because `compareReactNative()` does not verify the API contract.

- [x] **Step 3: Integrate the verifier and add the explicit package script**

Add `baseline:react-native:api` for direct verification and call the same verifier from `compareReactNative()`. Keep `baseline:react-native` as the complete gate used by maintainers.

- [x] **Step 4: Make CI validate the committed contract without an external checkout**

Add a `validate` mode that recomputes the contract's internal digest and schema invariants. Run it from the existing Rust/tooling CI job:

```bash
node tools/baseline/react-native-api-contract.mjs validate \
  --contract protocol/baseline/react-native-public-api-0.0.65.json \
  --baseline-metadata protocol/baseline/react-native-sdk-0.0.65.json
```

- [x] **Step 5: Run tooling and the full pinned comparison**

```bash
npm run test:tooling
SDK_BASELINE=${SDK_BASELINE:?set SDK_BASELINE to a clean 0.0.65 checkout}
npm run baseline:react-native -- \
  --sdk-path "$SDK_BASELINE" \
  --expected-commit 44ac1221cb71eb01cafcdbfdf7a370847d3a10b4
```

Expected: fixture schema PASS, 8 Jest suites PASS, 86 Jest tests PASS, 50 fixture cases PASS, and public API contract PASS.

- [x] **Step 6: Commit workflow enforcement**

```bash
git add .github/workflows/ci.yml package.json tools/baseline/compare-react-native.mjs tools/baseline/compare-react-native.test.mjs
git commit -m "ci: enforce React Native public API baseline" -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 4: Architecture and Contributor Contract

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-28-app-sdk-implementation.md`

**Interfaces:**
- Consumes: the committed public API contract and enforced baseline command.
- Produces: the documented entry gate for the later `frameworks/react-native` TurboModule plan.

- [x] **Step 1: Document the contract boundary**

State that protocol fixture parity is necessary but insufficient; the target package must also match the committed export/member digest. Record that private/internal legacy modules are excluded and that high-volume recording bytes remain native in the later bridge.

- [x] **Step 2: Mark the Milestone 4 prerequisite complete**

Update the implementation plan to distinguish the completed public API freeze from the still-open Apple bridge, Android bridge, app acceptance, and publication gates.

- [x] **Step 3: Run documentation-token searches**

```bash
rg -n "react-native-public-api|surfaceDigest|baseline:react-native" \
  README.md ARCHITECTURE.md AGENTS.md docs protocol tools .github
```

Expected: every new authority and command is described consistently.

- [x] **Step 4: Run the final gate**

```bash
npm ci
npm run check
npm run test:tooling
npm run test:release
cargo fmt --all -- --check
cargo test --workspace
git diff --check
```

Expected: PASS.

- [x] **Step 5: Commit documentation**

```bash
git add AGENTS.md ARCHITECTURE.md README.md docs/superpowers/plans/2026-08-28-app-sdk-implementation.md docs/superpowers/plans/2026-08-31-react-native-public-api-contract.md
git commit -m "docs: define React Native compatibility gate" -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

## Completion Gate

- A clean 0.0.65 checkout produces the committed semantic contract exactly.
- Missing or stale dependency declarations fail extraction instead of silently
  reducing or changing the captured API; the installed tree must match
  `package-lock.json` after `npm ci`, except for packages the lock marks optional
  and npm omits for the current platform.
- Any exported symbol or reachable public member addition, removal, or signature
  change fails with a named diff.
- Baseline package, version, source revision, normalized contract path, and
  digest must identify the same captured contract.
- Existing protocol fixtures, source digests, and Jest count gates still pass.
- CI validates contract integrity without requiring the sibling React Native repository.
- No React Native package is published and no native runtime capability is claimed by this milestone.

The next plan starts `frameworks/react-native` only after this contract is merged. It defines a Codegen TurboModule compatible with the Demo/Bota One React Native floor, an Objective-C++ adapter over `BotaAppleSDK`, and an Android adapter over the Android facade; it cannot claim cross-platform parity before the Android facade is implemented.
