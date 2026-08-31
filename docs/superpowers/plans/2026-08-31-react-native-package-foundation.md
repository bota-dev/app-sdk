# React Native Package Foundation Implementation Plan

> **For agentic workers:** Execute each checked step in order, keep the package private until both native adapters and the compatibility contract pass, and include the repository's required Codex co-author trailer in every commit.

**Goal:** Establish `frameworks/react-native` as a version-synchronized, Codegen-validated TurboModule package foundation for the Bota App SDK without publishing it or claiming runtime parity before Apple and Android adapters are complete.

**Architecture:** The nested package is independently installable so its React Native toolchain does not inflate the root tooling dependency graph. JavaScript exposes a guarded lifecycle wrapper over an optional `TurboModuleRegistry.get` lookup; importing the package is safe before a native rebuild, while invoking it without the native module returns a stable SDK error. The initial Codegen contract contains only low-volume lifecycle and capability values. Recording and firmware bytes remain in native files and are prohibited from the bridge contract.

**Tech Stack:** Node.js 22, TypeScript 6.0.3, React Native 0.86.3 Codegen, React 19.2.3, React Native Builder Bob 0.43, Node test runner, GitHub Actions.

**Spec:** `docs/superpowers/plans/2026-08-28-app-sdk-implementation.md` Milestone 4, `ARCHITECTURE.md` Migration Rule, and `protocol/baseline/react-native-public-api-0.0.65.json`.

## Release Boundary

- The package name is `@bota.dev/react-native-sdk`, but `private: true` prevents accidental npm publication.
- Its version must equal `sdk-version.toml` and the root package version.
- React Native 0.86.3 is the initial migration and Codegen floor because it is the New Architecture version used by Demo and Bota One.
- The package does not replace the production React Native SDK, switch an app, or appear in release manifests in this slice.
- The initial native module name is `BotaDeviceSDK` and is frozen by tests before adapter implementation.
- Native module lookup is optional at import time. The public wrapper throws `native_module_unavailable` only when a native operation is invoked without a linked module.
- The bridge carries configuration, state, capability, identifiers, progress, errors, and native file paths only. It never carries recording chunks, firmware chunks, base64 payloads, `ArrayBuffer`, or numeric byte arrays.

## Task 1: Package Metadata And Version Gate

**Files:**
- Create: `frameworks/react-native/package.json`
- Create: `frameworks/react-native/package-lock.json`
- Create: `frameworks/react-native/tsconfig.json`
- Create: `frameworks/react-native/tsconfig.build.json`
- Create: `frameworks/react-native/bob.config.js`
- Create: `tools/react-native/verify-package.mjs`
- Create: `tools/react-native/verify-package.test.mjs`
- Modify: `package.json`

- [x] Write tests that reject a public package, a package-name mismatch, an SDK-version mismatch, a React Native floor mismatch, and an unexpected native module name.
- [x] Run the focused test and confirm it fails because package metadata and the verifier do not exist.
- [x] Add the minimum package metadata and verifier needed to pass.
- [x] Generate and commit the nested lockfile with exact development tool versions.
- [x] Add root `react-native:verify` and `test:react-native` scripts.
- [x] Verify the package remains private and version-synchronized.

## Task 2: Lifecycle TurboModule Contract

**Files:**
- Create: `frameworks/react-native/src/specs/NativeBotaDeviceSDK.ts`
- Create: `frameworks/react-native/src/nativeModule.ts`
- Create: `frameworks/react-native/src/index.ts`
- Create: `frameworks/react-native/test/lifecycle.test.mjs`
- Create: `frameworks/react-native/test/bridge-contract.test.mjs`
- Create: `frameworks/react-native/test/fixtures/react-native.mjs`

- [x] Write lifecycle tests for guarded module lookup, stable unavailable errors, configure, destroy, and capability reads.
- [x] Write bridge-contract tests that require the module name and lifecycle methods and reject byte-bearing Codegen types and suspicious payload fields.
- [x] Run the focused tests and confirm they fail before the source exists.
- [x] Implement the Codegen spec and thin wrapper without adapter logic.
- [x] Export only foundation APIs; do not claim the frozen 0.0.65 public surface yet.
- [x] Run type checking, Bob build, and focused tests.

## Task 3: Deterministic Codegen Gate

**Files:**
- Create: `frameworks/react-native/scripts/generate-codegen.mjs`
- Create: `frameworks/react-native/scripts/verify-codegen.mjs`
- Create: `frameworks/react-native/test/codegen.test.mjs`
- Create: `frameworks/react-native/generated/`
- Modify: `frameworks/react-native/package.json`
- Modify: `.gitignore`

- [x] Write a test that expects committed iOS and Android schemas/artifacts and detects generated drift.
- [x] Run it and confirm the missing output failure.
- [x] Invoke the pinned React Native library Codegen command for both platforms in a temporary directory.
- [x] Normalize only machine-dependent paths and commit the stable generated contract artifacts needed for review.
- [x] Add `codegen`, `codegen:check`, and package `verify` scripts.
- [x] Prove a second generation produces no diff.

## Task 4: CI, Licenses, And Documentation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/license-gate.yml`
- Modify: `AGENTS.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/superpowers/plans/2026-08-28-app-sdk-implementation.md`
- Modify: `README.md`

- [x] Add an isolated React Native CI job that installs the nested lockfile and runs its full verification.
- [x] Scan the nested package dependencies in the license workflow.
- [x] Document package authority, versioning, Codegen floor, import behavior, native-byte boundary, and open adapter gates.
- [x] Mark only the package-foundation and lifecycle-Codegen prerequisite complete in Milestone 4.
- [x] Confirm customer-facing docs still describe Apple as the only published App SDK facade.

## Task 5: Verification And Integration

- [x] Run `npm ci` and `npm run verify` in `frameworks/react-native`.
- [x] Run root `npm ci`, `npm run test:tooling`, `npm run check:licenses`, and `npm run react-native:verify`.
- [x] Run `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets --all-features -- -D warnings`, and `cargo test --workspace`.
- [x] Search the full documentation surface for `BotaDeviceSDK`, `frameworks/react-native`, `native_module_unavailable`, and the React Native floor; update every relevant hit.
- [x] Request an independent review and resolve all findings.
- [x] Commit focused changes with the required co-author trailer, merge to `main`, push, and confirm remote CI.

## Exit Criteria

- `frameworks/react-native` installs reproducibly from its own lockfile and cannot be published accidentally.
- Package metadata and version are machine-checked against the App SDK source of truth.
- The lifecycle TurboModule spec passes TypeScript and React Native 0.86.3 Codegen for iOS and Android.
- Importing the JavaScript package without the native binary does not throw; invoking a native operation returns the stable unavailable error.
- The checked bridge contract cannot carry recording or firmware payload bytes.
- Generated Codegen review artifacts are deterministic and CI rejects drift.
- Root and nested license, tooling, Rust, and package checks pass.
- Remaining React Native workflow bindings over both native facades, 0.0.65 API
  compatibility, app migration, and npm publication remain open.

## Follow-On Status

As of 2026-08-31, both lifecycle adapters and the discovery, connection,
device-status, provisioning, authenticated-reset, recording-list/transfer, and
upload-ownership workflow slices are complete. Apple configure,
destroy, state, capabilities, discovery, selected-device connect,
serial-strict reconnect, disconnect, status reads, status subscriptions,
provision, remove-only deprovision, factory reset, exact-generation reset
receipt recovery, recording list, recording transfer, and upload ownership call
`BotaAppleSDK` through serialized Swift actors and pass a full CocoaPods
application compile-and-link gate. Android delegates the same surface to
`BotaDeviceClient.shared`, contains asynchronous scan/status failures, and
passes a
checked-in Codegen, Kotlin-test, lint, and release-assembly consumer against the
packaged AAR. JavaScript preserves the frozen scan filters, status shape, and
date mapping, and resolves nonce-bound provisioning and reset material through
one-shot native request IDs. Reset grants become bytes only in native code;
resume cannot request a grant or resend destructive opcode `0x06`. Recording
metadata and progress cross Codegen, while completed audio remains a native
file and JavaScript receives only its path. Upload handoff crosses Codegen as
opaque identifiers, progress, and the reducer-authorized ownership result;
destination URLs and credentials remain native. The package also matches the 75 frozen
`0.0.65` exports that do not own native workflows, with runtime coverage for
errors, sync-status derivation, and device-log decoding. `BotaClient`,
`DeviceManager`, `RecordingManager`, `StreamingSession`, `OTAManager`, app
migration, and npm publication are still open.
