# Bota App SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task by task. Do not begin a later milestone until the preceding exit criteria pass.

**Goal:** Establish `app-sdk` as the single source monorepo for the Bota App SDK family, preserve the behavior of the production React Native SDK, and migrate to one Rust protocol/workflow core with native platform transports through independently releasable milestones.

**Architecture:** The Rust core owns protocol parsing, serialization, cryptographic envelopes, workflow state, retry decisions, checkpoints, and stable errors. Swift/CoreBluetooth, Kotlin/BluetoothGatt, C#/WinRT GATT, and TypeScript/Web Bluetooth own operating-system integration. React Native and Flutter delegate to native facades. The SDK accepts backend-issued grants and presigned upload targets from the host application; it does not become a Bota API client.

**Tech Stack:** Rust 1.98.0, Cargo workspace, Node.js 22 tooling, TypeScript, Swift Package Manager, Kotlin/Gradle, C#/.NET, Flutter/Dart, WebAssembly, GitHub Actions.

**Normative design:** private Bota cross-system `App SDK Architecture.md`

## Program Baseline

The migration begins from these pinned source revisions:

| Component | Revision | Role during migration |
| --- | --- | --- |
| React Native SDK | `44ac1221cb71` | Behavioral reference and supported production implementation |
| Native Apple SDK | `cd15e545cabb` | Parser/model scaffold and future Apple facade seed |
| Native Android SDK | `0f06d2a22c55` | Parser/model scaffold and future Android facade seed |
| Firmware | `8b175a89374c` | Device-side compatibility reference |

The React Native baseline must remain releasable until Milestone 4 passes its
physical-device acceptance suite. No application switches to monorepo code in
Milestones 1 or 2.

## Delivery Sequence

| Milestone | Deliverable | Exit criterion |
| --- | --- | --- |
| 1 | Repository foundation and pure protocol core | Rust parses and serializes all captured fixtures byte-for-byte with React Native SDK `44ac1221cb71` |
| 2 | Deterministic workflow core | Fake-transport parity covers provisioning, reconnect, transfer, OTA, reset, cancellation, and upload handoff |
| 3 | Apple and Android native facades | Both native packages pass conformance plus the physical-device P0 matrix |
| 4 | React Native migration | Demo and Bota One pass local, preview, and production acceptance while the compatibility package preserves its public API |
| 5 | Web/Electron, Flutter, and Windows facades | Each artifact passes its declared capability matrix and package smoke test |
| 6 | Unified release and legacy-repository retirement | One versioned release manifest publishes every supported artifact; old repositories contain migration-only content |

Each milestone receives its own execution plan after the preceding milestone
freezes the interfaces it consumes. This document provides the full program
order and a complete, executable plan for Milestone 1. That avoids specifying
FFI and facade work against protocol types that have not yet passed parity.

## Milestone 1: Foundation And Protocol Core

### Task 1: Establish repository governance and pinned toolchains

**Files:**

- Create: `.gitignore`
- Create: `.nvmrc`
- Create: `rust-toolchain.toml`
- Create: `Cargo.toml`
- Create: `package.json`
- Create: `LICENSE`
- Create: `README.md`
- Create: `ARCHITECTURE.md`
- Create: `AGENTS.md`
- Create: `CLAUDE.md`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `sdk-version.toml`
- Create: `core/device-sdk-core/Cargo.toml`
- Create: `core/device-sdk-core/src/lib.rs`
- Test: `core/device-sdk-core/tests/version_contract.rs`

**Step 1: Write the failing version-contract test**

```rust
use std::{fs, path::PathBuf};

#[test]
fn crate_version_matches_workspace_sdk_version() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let manifest = fs::read_to_string(root.join("sdk-version.toml")).unwrap();
    let sdk_version = manifest
        .lines()
        .find_map(|line| line.strip_prefix("version = \"")?.strip_suffix('"'))
        .unwrap();

    assert_eq!(env!("CARGO_PKG_VERSION"), sdk_version);
}
```

**Step 2: Run the test and confirm the scaffold is incomplete**

Run: `cargo test -p bota-device-sdk-core --test version_contract`

Expected: FAIL because the workspace, crate, or `sdk-version.toml` does not yet
exist.

**Step 3: Install the pinned local toolchains**

The current workstation has Node 16 and does not have `rustup` or Cargo. Install
the tools before creating generated files:

```bash
nvm install 22
nvm use 22
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --default-toolchain none --no-modify-path
export PATH="$HOME/.cargo/bin:$PATH"
rustup toolchain install 1.98.0 --component rustfmt --component clippy
```

Do not install Flutter or .NET in Milestone 1; no code in this milestone uses
them.

**Step 4: Create the minimum workspace**

Pin `rust-toolchain.toml` to Rust `1.98.0` with `rustfmt` and `clippy`. Pin
`.nvmrc` to Node `22`. Start `sdk-version.toml` at `0.1.0-alpha.1` and use that
same version in the Rust crate.

The root Cargo workspace initially contains:

```toml
[workspace]
resolver = "2"
members = [
  "core/device-sdk-core",
  "tools/xtask",
]
```

The npm root is private and is used only for repository tooling until framework
packages are added:

```json
{
  "name": "@bota.dev/app-sdk-workspace",
  "private": true,
  "engines": { "node": ">=22" },
  "scripts": {
    "check": "npm run check:licenses",
    "check:licenses": "node scripts/check-licenses.mjs"
  }
}
```

Document these invariants in `ARCHITECTURE.md` and `AGENTS.md`:

- `app-sdk` is the source-repository name; Bota App SDK is the public family.
- The future Bota API SDK is a separate repository and release train.
- Platform transports stay native; protocol and workflow behavior belongs in
  Rust.
- All published artifacts use `sdk-version.toml`.
- No literal credentials, tokens, certificate bodies, or private keys may be
  committed.

Make `CLAUDE.md` a symlink to `AGENTS.md` so agent guidance has one canonical
source.

**Step 5: Generate lockfiles and run repository checks**

Run:

```bash
rustup show
cargo generate-lockfile
npm install --package-lock-only
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Expected: all commands PASS and `Cargo.lock` plus `package-lock.json` are
created.

**Step 6: Commit the repository foundation**

```bash
git add .gitignore .nvmrc rust-toolchain.toml Cargo.toml Cargo.lock \
  package.json package-lock.json LICENSE README.md ARCHITECTURE.md AGENTS.md \
  CLAUDE.md CONTRIBUTING.md SECURITY.md sdk-version.toml core
git commit -m "chore: scaffold app sdk monorepo"
```

### Task 2: Add CI, dependency updates, and license enforcement

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/license-gate.yml`
- Create: `.github/dependabot.yml`
- Create: `deny.toml`
- Create: `scripts/check-licenses.mjs`
- Create: `scripts/check-license-allowlist.json`
- Create: `scripts/__fixtures__/forbidden.json`
- Modify: `package.json`
- Modify: `CONTRIBUTING.md`

**Step 1: Add an intentionally forbidden npm license fixture**

Add a temporary test mode to `scripts/check-licenses.mjs` that accepts a JSON
dependency report. Create a test report containing one dependency licensed
`GPL-3.0-only` and assert that the script exits non-zero.

Run: `node scripts/check-licenses.mjs --report scripts/__fixtures__/forbidden.json`

Expected: FAIL with the dependency name and license.

**Step 2: Implement the license gates**

The npm checker must reject GPL, AGPL, SSPL, BUSL, Elastic License, Commons
Clause, and MPL families. `scripts/check-license-allowlist.json` is only for a
documented false positive such as a package that is actually dual-licensed
under an approved license; it must not bypass a genuinely forbidden license.
The Cargo gate uses `cargo-deny` `0.20.2` with the same policy in `deny.toml`.

Do not add UniFFI, `cbindgen`, or any other FFI generator in this milestone.
The binding-tool decision must pass the license gate and the Milestone 2 ABI
spike before adoption.

**Step 3: Add CI jobs**

`ci.yml` must run on pull requests and pushes to `main` with:

- Rust format check;
- Clippy with warnings denied;
- workspace tests;
- protocol generation drift check once Task 5 lands;
- npm tooling tests.

Set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` at workflow level. Pin action
versions and enable Cargo/npm caching.

`license-gate.yml` runs `cargo deny check licenses` and the npm license script.
Dependabot tracks `cargo`, `npm`, and `github-actions` weekly.

**Step 4: Verify locally**

Run:

```bash
cargo install cargo-deny --version 0.20.2 --locked
npm run check:licenses
cargo deny check licenses
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Expected: PASS. The forbidden fixture test still proves that a disallowed
license is rejected.

**Step 5: Commit supply-chain controls**

```bash
git add .github deny.toml scripts package.json package-lock.json CONTRIBUTING.md
git commit -m "ci: add sdk quality and license gates"
```

### Task 3: Define the synchronized version and release-manifest contract

**Files:**

- Create: `release/schema/release-manifest.schema.json`
- Create: `release/examples/0.1.0-alpha.1.json`
- Create: `tools/xtask/Cargo.toml`
- Create: `tools/xtask/src/main.rs`
- Test: `tools/xtask/tests/release_manifest.rs`
- Modify: `ARCHITECTURE.md`
- Modify: `.github/workflows/ci.yml`

**Step 1: Write a failing manifest-validation test**

The test loads the example manifest and asserts:

- manifest version equals `sdk-version.toml`;
- source revision is a 40-character Git SHA;
- every artifact reports the same SDK version;
- firmware compatibility contains explicit minimum and maximum versions;
- checksums are lowercase SHA-256 strings;
- capabilities are declared per artifact.

Run: `cargo test -p xtask --test release_manifest`

Expected: FAIL because the schema, example, and validation command do not exist.

**Step 2: Implement `cargo xtask release validate`**

Use typed Rust structures with `serde` and `serde_json`; do not validate with
string matching. The example manifest declares only
`bota-device-sdk-core` in Milestone 1. Later packages are added only when they
can be built in release CI.

The CLI contract is:

```bash
cargo xtask release validate release/examples/0.1.0-alpha.1.json
```

**Step 3: Add CI validation and document release invariants**

CI runs the validation command. `ARCHITECTURE.md` states that an artifact is not
publishable unless it appears in the release manifest and matches
`sdk-version.toml`.

**Step 4: Verify and commit**

Run:

```bash
cargo test -p xtask --test release_manifest
cargo xtask release validate release/examples/0.1.0-alpha.1.json
cargo test --workspace
```

Expected: PASS.

```bash
git add release tools/xtask ARCHITECTURE.md .github/workflows/ci.yml Cargo.toml Cargo.lock
git commit -m "feat: define synchronized sdk release manifest"
```

### Task 4: Freeze the React Native compatibility baseline

**Files:**

- Create: `protocol/fixtures/schema/fixture-suite.schema.json`
- Create: `protocol/fixtures/device-status.json`
- Create: `protocol/fixtures/recording-list.json`
- Create: `protocol/fixtures/transfer-control.json`
- Create: `protocol/fixtures/connection-settings.json`
- Create: `protocol/fixtures/provisioning.json`
- Create: `protocol/fixtures/device-logs.json`
- Create: `protocol/fixtures/ota.json`
- Create: `protocol/baseline/react-native-sdk-0.0.65.json`
- Create: `tools/baseline/compare-react-native.mjs`
- Test: `tools/baseline/compare-react-native.test.mjs`
- Modify: `package.json`
- Modify: `ARCHITECTURE.md`
- Reference: sibling `react-native-sdk/__tests__/` checkout
- Reference: sibling `react-native-sdk/src/ble/` checkout
- Reference: sibling `firmware/sdk/apps/common/ble/le_trans_data.c` checkout

**Step 1: Define a fixture suite and make schema validation fail**

Every fixture case uses a language-neutral envelope:

```json
{
  "schemaVersion": 1,
  "protocolRevision": "firmware-8b175a89374c",
  "cases": [
    {
      "name": "idle-device-status",
      "inputHex": "...",
      "expected": { "recordingState": "idle" }
    }
  ]
}
```

Write a Node test that validates every fixture against the JSON Schema and
rejects duplicate case names, odd-length hex, and undocumented expected fields.

Run: `node --test tools/baseline/compare-react-native.test.mjs`

Expected: FAIL before the schema and complete fixture files exist.

**Step 2: Capture all shipped protocol surfaces**

Derive cases from existing React Native tests and firmware packet definitions.
At minimum include:

- valid, truncated, unknown-enum, and forward-compatible device status packets;
- empty, single, and multi-entry recording lists;
- transfer START, DATA, ACK, COMPLETE, CANCEL, and error control packets;
- connection settings with `0`, `-1`, minimum finite timeouts, channel order,
  heartbeat channel, and Bota Note cellular normalization;
- provisioning nonce, `PK_D`, environment, bind, deprovision, and authenticated
  reset receipt envelopes;
- device log list and chunk packets;
- OTA metadata, acceptance, rejection, progress, and completion packets.

The fixture expected values must be copied from test-observed behavior, not
reinterpreted from prose.

**Step 3: Compare fixtures against the pinned React Native SDK**

`compare-react-native.mjs` accepts an explicit checkout:

```bash
npm run baseline:react-native -- \
  --sdk-path ../react-native-sdk \
  --expected-commit 44ac1221cb71
```

The script must:

1. refuse a dirty SDK checkout unless `--allow-dirty` is supplied;
2. confirm package version `0.0.65` and the expected commit;
3. build the SDK;
4. run its existing Jest suite;
5. exercise exported or internal built parsers against every applicable case;
6. write no source files;
7. emit a deterministic SHA-256 digest of the fixture set.

Record the full source SHA, package version, firmware SHA, fixture digest, and
test counts in `protocol/baseline/react-native-sdk-0.0.65.json`.

**Step 4: Verify the frozen baseline**

Run:

```bash
npm run test:fixtures
npm run baseline:react-native -- \
  --sdk-path ../react-native-sdk \
  --expected-commit 44ac1221cb71
```

Expected: fixture schema PASS; React Native 8 suites and 86 tests PASS; every
applicable fixture matches; the recorded digest is unchanged.

**Step 5: Commit the compatibility contract**

```bash
git add protocol tools/baseline package.json package-lock.json ARCHITECTURE.md
git commit -m "test: freeze react native protocol behavior"
```

### Task 5: Make the protocol manifest the generated constants source

**Files:**

- Create: `protocol/manifest/device-protocol.yaml`
- Create: `protocol/manifest/schema.json`
- Create: `tools/xtask/src/protocol.rs`
- Create: `core/device-sdk-core/src/generated/mod.rs`
- Create: `core/device-sdk-core/src/generated/protocol.rs`
- Test: `tools/xtask/tests/protocol_codegen.rs`
- Modify: `core/device-sdk-core/src/lib.rs`
- Modify: `.github/workflows/ci.yml`
- Modify: `ARCHITECTURE.md`

**Step 1: Write the failing generation-drift test**

The test copies the checked-in generated Rust file to a temporary directory,
runs the generator, and asserts byte-for-byte equality.

Run: `cargo test -p xtask --test protocol_codegen`

Expected: FAIL because the manifest and generator do not exist.

**Step 2: Encode only stable wire facts in YAML**

The manifest contains:

- service and characteristic UUIDs;
- opcodes and response codes;
- packet field order, widths, signedness, and endianness;
- protocol feature introduction versions;
- maximum payload sizes;
- reserved values.

It does not contain application UI labels, backend routes, retry policy, or
platform permission behavior.

**Step 3: Implement deterministic code generation**

Provide:

```bash
cargo xtask protocol generate
cargo xtask protocol generate --check
```

Generation must sort map-derived content, include a source digest in the file
header, and write only when content changes. Never edit
`core/device-sdk-core/src/generated/protocol.rs` by hand.

**Step 4: Verify and commit**

Run:

```bash
cargo xtask protocol generate --check
cargo test -p xtask --test protocol_codegen
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: PASS.

```bash
git add protocol/manifest tools/xtask core/device-sdk-core/src/generated \
  core/device-sdk-core/src/lib.rs .github/workflows/ci.yml ARCHITECTURE.md Cargo.lock
git commit -m "feat: generate protocol constants from manifest"
```

### Task 6: Implement stable core models and errors

**Files:**

- Create: `core/device-sdk-core/src/error.rs`
- Create: `core/device-sdk-core/src/model/mod.rs`
- Create: `core/device-sdk-core/src/model/device.rs`
- Create: `core/device-sdk-core/src/model/recording.rs`
- Create: `core/device-sdk-core/src/model/settings.rs`
- Create: `core/device-sdk-core/src/model/provisioning.rs`
- Create: `core/device-sdk-core/src/model/ota.rs`
- Test: `core/device-sdk-core/tests/model_contract.rs`
- Modify: `core/device-sdk-core/src/lib.rs`
- Modify: `ARCHITECTURE.md`

**Step 1: Write failing model and error tests**

Cover:

- unknown enum values survive decode/encode without data loss;
- device serial numbers and recording UUIDs reject malformed values;
- Bota Note settings cannot enable cellular or include cellular in priority;
- timeout semantics preserve `0` as immediate-off and `-1` as always-on;
- errors have a stable machine code, operation, retryability, and optional
  protocol status without exposing platform error text as identity.

The stable error shape is:

```rust
pub struct DeviceSdkError {
    pub code: ErrorCode,
    pub operation: Operation,
    pub retryable: bool,
    pub protocol_status: Option<u16>,
    pub detail: Option<String>,
}
```

Run: `cargo test -p bota-device-sdk-core --test model_contract`

Expected: FAIL because the model modules do not exist.

**Step 2: Implement the minimum domain model**

Use owned Rust types and explicit constructors for validated identifiers. Do
not include CoreBluetooth, Android, JavaScript, Dart, or .NET types in the core.
Keep platform diagnostics in `detail`; public logic branches on `code`.

**Step 3: Verify and commit**

Run:

```bash
cargo test -p bota-device-sdk-core --test model_contract
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Expected: PASS.

```bash
git add core/device-sdk-core ARCHITECTURE.md Cargo.lock
git commit -m "feat: add device sdk core models and errors"
```

### Task 7: Implement fixture-driven parsers

**Files:**

- Create: `core/device-sdk-core/src/protocol/mod.rs`
- Create: `core/device-sdk-core/src/protocol/cursor.rs`
- Create: `core/device-sdk-core/src/protocol/status.rs`
- Create: `core/device-sdk-core/src/protocol/recordings.rs`
- Create: `core/device-sdk-core/src/protocol/settings.rs`
- Create: `core/device-sdk-core/src/protocol/provisioning.rs`
- Create: `core/device-sdk-core/src/protocol/logs.rs`
- Create: `core/device-sdk-core/src/protocol/ota.rs`
- Test: `core/device-sdk-core/tests/fixture_decode.rs`
- Modify: `core/device-sdk-core/src/lib.rs`

**Step 1: Write the failing fixture decoder**

Create a test harness that loads every JSON fixture, decodes `inputHex`, invokes
the named parser, serializes the typed result to normalized JSON, and compares
it with `expected`.

Run: `cargo test -p bota-device-sdk-core --test fixture_decode`

Expected: FAIL with one named failure per unimplemented protocol family.

**Step 2: Implement bounded binary reads**

`cursor.rs` is the only module allowed to advance through untrusted packet
bytes. It must return structured truncation errors containing required and
available lengths. Parsers must not index packet slices directly or panic on
arbitrary input.

Implement one protocol family at a time in this order:

1. device status;
2. recording list;
3. connection settings;
4. provisioning and reset receipts;
5. device logs;
6. OTA responses.

After each family, run its filtered fixture test before continuing.

**Step 3: Add arbitrary-input panic resistance**

For each parser, loop through lengths `0..=maximum_payload + 16` with
deterministic byte patterns and assert that parsing returns `Ok` or `Err` but
never panics. Add property-based fuzzing only after these deterministic tests
pass; do not make a fuzzer a prerequisite for ordinary CI.

**Step 4: Verify and commit**

Run:

```bash
cargo test -p bota-device-sdk-core --test fixture_decode
cargo test -p bota-device-sdk-core
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: every decode fixture PASS and arbitrary input causes no panic.

```bash
git add core/device-sdk-core Cargo.lock
git commit -m "feat: parse device protocol fixtures in rust"
```

### Task 8: Implement byte-exact serializers and normalization

**Files:**

- Create: `core/device-sdk-core/src/protocol/encode.rs`
- Create: `core/device-sdk-core/src/protocol/transfer.rs`
- Test: `core/device-sdk-core/tests/fixture_encode.rs`
- Test: `core/device-sdk-core/tests/round_trip.rs`
- Modify: `core/device-sdk-core/src/protocol/settings.rs`
- Modify: `core/device-sdk-core/src/lib.rs`

**Step 1: Write failing encode and round-trip tests**

For every fixture with an `expectedHex` field, construct the typed input,
encode it, and compare bytes exactly. For bidirectional packets, assert:

```rust
assert_eq!(decode(encode(value)?)?, value);
```

Include transfer START, ACK, CANCEL, recording CONFIRM, connection settings,
WiFi provisioning, bind provisioning, deprovision, reset, and OTA commands.

Run:

```bash
cargo test -p bota-device-sdk-core --test fixture_encode
cargo test -p bota-device-sdk-core --test round_trip
```

Expected: FAIL before serializers exist.

**Step 2: Implement serializers with explicit capacity checks**

Serializers return `payload_too_large` before allocation or BLE write. Device
model normalization happens before encoding:

- Bota Note forces `cellular = false`;
- Bota Note removes cellular from upload priority;
- `0` and `-1` timeout semantics are preserved;
- unknown heartbeat channel values remain representable for forward
  compatibility.

**Step 3: Re-run React Native comparison**

Run:

```bash
npm run baseline:react-native -- \
  --sdk-path ../react-native-sdk \
  --expected-commit 44ac1221cb71
cargo test --workspace
```

Expected: byte-for-byte parity PASS.

**Step 4: Commit serializers**

```bash
git add core/device-sdk-core
git commit -m "feat: serialize device protocol commands in rust"
```

### Task 9: Define the workflow host boundary without choosing FFI

**Files:**

- Create: `core/device-sdk-core/src/engine/mod.rs`
- Create: `core/device-sdk-core/src/engine/command.rs`
- Create: `core/device-sdk-core/src/engine/event.rs`
- Create: `core/device-sdk-core/src/engine/effect.rs`
- Create: `core/device-sdk-core/src/engine/capability.rs`
- Create: `core/device-sdk-core/src/engine/checkpoint.rs`
- Test: `core/device-sdk-core/tests/engine_contract.rs`
- Create: `docs/adr/0001-command-event-host-boundary.md`
- Modify: `ARCHITECTURE.md`

**Step 1: Write failing boundary tests**

Assert that:

- unsupported capabilities fail before emitting a transport write;
- every effect carries an operation and cancellation ID;
- timer, persistence, secure storage, BLE, network upload, and progress are
  explicit effects;
- platform callbacks enter the core only as typed events;
- checkpoints contain no plaintext credentials or recording payloads;
- the core contains no runtime, thread, Bluetooth, HTTP-client, or filesystem
  dependency.

Run: `cargo test -p bota-device-sdk-core --test engine_contract`

Expected: FAIL before the boundary types exist.

**Step 2: Implement types, not workflows**

The core boundary follows a deterministic reducer:

```rust
pub trait Workflow {
    fn dispatch(&mut self, event: Event) -> Result<Vec<Effect>, DeviceSdkError>;
}
```

Milestone 1 defines the vocabulary and invariants only. Reconnect, transfer,
OTA, provisioning, and reset state machines are Milestone 2 work.

**Step 3: Record the FFI decision criteria**

ADR 0001 must require the Milestone 2 binding spike to compare a candidate
generator with a manually owned C ABI on:

- Swift, Kotlin/JNI, C#, and Dart support;
- async cancellation and event delivery;
- large byte-buffer copies;
- generated-code reviewability;
- binary size;
- supported licenses under the repository gate;
- reproducible CI and toolchain pinning.

No binding generator is adopted merely because it generates the largest number
of languages.

**Step 4: Verify and commit**

Run:

```bash
cargo test -p bota-device-sdk-core --test engine_contract
cargo tree -p bota-device-sdk-core
cargo test --workspace
```

Expected: PASS; dependency tree contains no platform transport or async runtime.

```bash
git add core/device-sdk-core docs/adr ARCHITECTURE.md Cargo.lock
git commit -m "feat: define portable workflow host boundary"
```

### Task 10: Close Milestone 1 with reproducible evidence

**Files:**

- Create: `protocol/compatibility/firmware-compatibility.json`
- Create: `release/evidence/0.1.0-alpha.1.md`
- Modify: `release/examples/0.1.0-alpha.1.json`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `sdk-version.toml` only if the implementation changed the planned prerelease version

**Step 1: Write the compatibility matrix**

Record each protocol feature, the earliest known firmware version, fixture
coverage, Rust support, and React Native baseline support. A feature cannot be
marked supported without at least one valid and one invalid fixture.

**Step 2: Run the complete milestone gate**

Run:

```bash
node --version
rustc --version
npm ci
npm run check
npm run test:fixtures
npm run baseline:react-native -- \
  --sdk-path ../react-native-sdk \
  --expected-commit 44ac1221cb71
cargo xtask protocol generate --check
cargo xtask release validate release/examples/0.1.0-alpha.1.json
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
git diff --check
```

Expected:

- Node reports major version 22;
- Rust reports 1.98.0;
- React Native reports 8 passing suites and 86 passing tests;
- all fixture, generation, lint, license, and Rust tests pass;
- the worktree contains only intentional milestone evidence updates.

**Step 3: Record evidence**

`release/evidence/0.1.0-alpha.1.md` records command versions, source SHAs,
fixture digest, test counts, and any explicitly accepted warning. Do not claim
Apple, Android, React Native replacement, Web, Flutter, Windows, or
physical-device support in this prerelease.

**Step 4: Commit milestone evidence**

```bash
git add protocol/compatibility release README.md ARCHITECTURE.md sdk-version.toml
git commit -m "docs: record protocol core milestone evidence"
```

**Step 5: Push the initial repository history**

Run:

```bash
git status --short --branch
git log --oneline --decorate -10
git push -u origin main
```

Expected: clean `main` tracking `origin/main`, with the ten focused commits in
this milestone. Do not publish a public package until repository protection,
CI, and release credentials are configured.

## Subsequent Milestone Scope

### Milestone 2: Deterministic workflow core

Execute
`docs/superpowers/plans/2026-08-30-app-sdk-workflow-core.md` after Milestone 1
passes.
It must cover one workflow per focused commit in this order:

1. transport simulator and deterministic clock;
2. device discovery identity and candidate selection;
3. connection, service discovery, disconnect cleanup, and reconnect ownership;
4. provisioning journal, bind confirmation, deprovision, and authenticated reset;
5. recording list and resumable transfer with checkpoints;
6. direct-to-presigned-S3 upload handoff without backend API ownership;
7. OTA download, device acceptance, transfer, reboot, and reconnect recovery;
8. device-log retrieval;
9. cancellation, timeout, retry, and concurrency parity;
10. FFI toolchain decision and a Swift/Kotlin smoke binding.

Exit only when old and new implementations pass the same scenario traces and
the command/event ABI is frozen for native facades.

### Milestone 3: Apple and Android facades

Import the useful native scaffolds from the pinned Apple and Android revisions
into `platforms/apple` and `platforms/android`. Replace their parser copies with
the shared core, implement CoreBluetooth and BluetoothGatt adapters, and publish
prerelease artifacts. Require physical-device tests for pairing, reconnect,
provisioning, recording transfer, settings, diagnostics, OTA, deprovision, and
authenticated reset. The old native repositories remain available until this
milestone is stable.

### Milestone 4: React Native migration

Create `frameworks/react-native` as a TurboModule over the Apple and Android
facades. Preserve `@bota.dev/react-native-sdk` behavior through a compatibility
package and migration tests. Switch Demo first, then Bota One, using local
package consumption before preview releases. Production rollout requires both
apps to pass reconnect-after-OTA, active-device selection, encrypted recording
upload, WiFi settings, BLE fallback, firmware download progress, device logs,
remove-only, and remove-and-reset acceptance.

Prerequisite status (2026-08-31): the 0.0.65 root TypeScript API is frozen as a
semantic contract covering 80 exports, expanded type aliases, static APIs, and
reachable public members, and the existing baseline command enforces it
alongside the 55 wire fixtures and 86 Jest tests. The private
`frameworks/react-native` package now pins React Native 0.86.3 and validates a
first lifecycle/capability TurboModule schema plus deterministic iOS and Android
artifact digests. Optional lookup prevents import-time failure before a native
rebuild, while invocation fails as `native_module_unavailable`. The Apple
lifecycle adapter now serializes configure and destroy through `BotaAppleSDK`.
The first device slices also support discovery, selected-device connect,
serial-strict reconnect, disconnect, current-status reads, and typed status
subscriptions while native actors own scan and status teardown. Provisioning
and grant-gated remove-only deprovision now delegate through the native facades;
deprovision writes its application grant, subscribes before opcode `0x05`, and
returns the typed firmware result. One-shot
request IDs keep asynchronous JavaScript material lookup inside the active
nonce-bound workflow. Connection-settings writes now expand the frozen
JavaScript defaults before Codegen, then delegate device-model normalization,
serialization, and BLE ownership to Apple and Android while preserving
heartbeat channel selection independently from upload preference.
The omitted heartbeat value retains the frozen both-channels-enabled default.
Connection-settings reads keep characteristic bytes and shared decoding in the
native facades, carry only the complete typed value through Codegen, and restore
the frozen snake-case JavaScript shape while filtering unknown future channels.
Authenticated factory reset now uses the same one-shot request ownership while
binding every grant and completion to the backend command ID and binding
generation. Apple and Android decode the
application-provided grant natively, and React Native resume delegates only to
exact-generation receipt recovery. Recording list, transfer, and upload
ownership now delegate to the native facades as well: metadata, progress,
opaque upload identifiers, and the terminal ownership decision cross Codegen,
while audio remains in a native file represented to JavaScript by its path and
upload destinations remain native. OTA follows the same ownership rule:
JavaScript supplies version, size, and a presigned URL, while native adapters
generate the opaque download registration, calculate CRC32 from the durable
download, and own HTTP and BLE bytes.
Device-log subscriptions now delegate to the public Apple and Android facades:
native code owns BLE framing, sequence recovery, UTF-8 assembly, and the single
active collector, while Codegen emits only complete sanitized lines and
JavaScript owns idempotent subscription teardown.
WiFi configuration now follows the same boundary. JavaScript passes typed
credentials and an encoded application grant; Apple and Android own grant and
credential packet writes, subscribe-before-write result ordering, shared Rust
status and scan decoding, and exactly-once notification teardown. Codegen emits
only typed configuration results, status values, and scan metadata.
A real CocoaPods application compiles and links the generated typed event spec,
Objective-C++, Swift, Swift Package, and Rust XCFramework layers. The Android
adapters provide the same lifecycle, connection, status, provisioning,
connection-settings reads and writes, authenticated-reset, recording-transfer,
upload-ownership, and OTA slices plus device logs through the public Android
facade, and a checked-in React Native Gradle
consumer runs Codegen, Kotlin tests,
lint, and release assembly against the exact packaged AAR. The
package now matches 79 of 80 frozen exports, including every public type, the
pure error, sync-status, and device-log runtime helpers, and the native-backed
`DeviceManager`, `RecordingManager`, `StreamingSession`, and `OTAManager`. Those owners keep
recording and live-stream payloads native while exposing only typed metadata
and progress through Codegen. `DeviceManager` preserves authenticated reset
recovery across app reinstallation and serializes native reconnect attempts.
`BotaClient`, app acceptance, and publication gates remain open.
High-volume recording and firmware bytes stay native and are rejected from the
Codegen contract.

### Milestone 5: Additional platforms

Implement in separate plans because capability and lifecycle contracts differ:

- Web/Electron: WASM core plus Web Bluetooth, foreground-only transfer, browser
  picker, and durable resumable errors;
- Flutter: native facade delegation on Apple and Android before desktop support;
- Windows: C# facade plus WinRT GATT, followed by Flutter Windows integration.

Never advertise unsupported background scan or reconnect behavior as parity.

### Milestone 6: Unified release and retirement

Extend release CI to build, sign, test, checksum, and publish every supported
artifact from one tag and one `sdk-version.toml`. Generate an SBOM, capability
matrix, API reference, migration notes, and signed release manifest. Convert
the old SDK repositories to migration READMEs only after Demo, Bota One, and at
least one external integration consume a stable monorepo release.

## Program Guardrails

- No firmware wire change is hidden inside an SDK migration.
- No backend API client is added to the Device SDK.
- No app consumes a local source link in a production release.
- No high-volume recording payload crosses JavaScript or Dart merely to report
  progress.
- No device identity is inferred from advertised name alone.
- No reset is described as successful before the authenticated device receipt
  closes the backend command.
- No legacy package is deprecated before its replacement has one stable release
  and a tested migration path.
- Every behavioral change updates the machine-readable fixture, relevant
  internal protocol document, public SDK documentation, and compatibility
  matrix in the same change.
