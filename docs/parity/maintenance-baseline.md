# Maintenance Baseline Gates

## Separate Authorities

The frozen `0.0.65` contract remains byte-for-byte unchanged at
`protocol/baseline/react-native-public-api-0.0.65.json`: 80 exports from
`44ac1221cb71eb01cafcdbfdf7a370847d3a10b4`. Its file SHA-256 is
`c50025b25396b228dccbe7300aaf638f562826a3c15adb9c60c2889fe58431ba`.
Old members, inherited APIs, signatures, optionality, and readonly modifiers
must remain exact. Only literal union ordering is normalized.

The separate maintenance source is `@bota.dev/react-native-sdk` `0.0.67` at
`318974f925a573cf04b0d624978bee04784af09b`. The additions contract is
`protocol/baseline/react-native-maintenance-additions-0.0.67.json`.
It records all 109 source exports by semantic digest, but requires only the
explicit scope below to be identical in the target React Native facade.

| Scope | Exact additive surface |
| --- | --- |
| Diagnostics | `DeviceDiagnosticEvent`, `DeviceDiagnosticEventType`, `DeviceDiagnosticReasonCode`, `DeviceDiagnosticsBatch`, `DeviceDiagnosticsDecoder`, `diagnosticEventIdCommand` |
| Device manager | `readDiagnosticEvents`, `acknowledgeDiagnosticEvents` |
| Recovery types | `RecordingDataStore`, `RecordingManagerOptions`, `UploadRecoveryContext`, `UploadRecoveryProvider`, `UPLOAD_RECOVERY_VERSION` |
| Config | Optional `recordingDataStore`, `uploadRecoveryProvider` |
| Upload info | Optional `alreadyUploaded`, `complete`, `dispose`, `recoveryScope`, `signal` |
| Upload task | Optional `complete`, `fileSizeBytes`, `nextAttemptAt`, `recordingUuid`, `recoveryScope`, `relayUpload` |
| Construction | Preserve `constructor()` and add `constructor(options: RecordingManagerOptions)` |

That is 11 new exports, 15 new members, and one explicit constructor overload.
The gate rejects unlisted members on frozen exports, missing new exports,
signature changes, and allowlist entries that overwrite frozen members or add
required data properties. Additional target-native exports are not maintenance
parity claims and are outside this comparison.

## Deliberate Boundaries

- `RecordingDataStore` is **type compatibility only**. Target configuration
  explicitly rejects its JavaScript byte callbacks. Recording bytes and files
  remain native-owned; presence of this interface is not runtime parity.
- Eighteen maintenance v2 exports are individually listed in
  `excludedExports`. They include material, ciphertext sink/file, checkpoint,
  provider, and policy APIs. They are not asserted identical to the target's
  opaque native registrations. Neither these exclusions nor this gate enable
  `runtimeWorkflow`, `firmwareAdvertised`, or change `contract_only`.
- The source inventory also records the five v2 `RecordingManager` methods,
  `ProvisioningResult.error` / `resetFinalized`, and inherited Error declaration
  differences. This focused additions gate does not implement those source
  differences, weaken the old target signatures, or claim all maintenance APIs
  and behaviors are identical.
- Type checks prove surface shape, not implementation behavior. Source Jest
  tests prove source behavior. Target diagnostics, upload-recovery, and native
  lost-ACK tests remain independent evidence owned by their implementations.

## Source Selection

`reactNativeBaseline` remains frozen at `0.0.65`.
`reactNativeWorkflowBaseline` and `reactNativeMaintenanceBaseline` both select
the exact `318974f` commit. All eight workflow suites retain 33 scenarios;
their commands and traces are unchanged. One obsolete source-test title was
replaced by `resumes the same accepted checkpoint across negotiated payload
changes`, which still asserts revision 7 and offset 100 rather than a reset.

The automatic CI and release checkout literals must match selected metadata.
Tooling tests inspect the bounded maintenance checkout blocks, not an unrelated
SHA elsewhere in the workflow. Existing `test:workflows` now also verifies the
maintenance source contract before runtime tests. No package-script changes or
additional CI jobs are needed.

Source verification requires an explicit checkout path, exact clean HEAD,
package version, dependencies installed from its lock with `npm ci`, Node 22,
and root TypeScript 6.0.3. It compares the complete source semantic digest,
dependency-lock digest, scoped additions, and source-difference inventory.
Unclassified new source exports stop capture. There is no sibling user-checkout
autodiscovery and no dirty-source escape in the maintenance contract gate.

A frozen release cannot establish whether an upstream branch has advanced.
Do not fetch mutable `main` or npm `latest` inside release verification.
For a maintenance audit, obtain the reviewed immutable source SHA separately
and pass it as `--expected-commit`; a stale selected baseline must fail rather
than silently report the old 80-export or 33-scenario evidence as current.
Updating a pin requires reviewing the new source inventory and limitations,
recapturing the additions contract, and updating both workflow checkout refs.
Historical tagged baselines remain immutable.

## Verification

Run from the repository root using the pinned toolchains and a clean reference
checkout at `BOTA_REACT_NATIVE_SDK_PATH`:

```sh
npm run test:tooling
node tools/baseline/react-native-api-contract.mjs verify-maintenance \
  --sdk-path "$BOTA_REACT_NATIVE_SDK_PATH" \
  --expected-commit 318974f925a573cf04b0d624978bee04784af09b \
  --contract protocol/baseline/react-native-maintenance-additions-0.0.67.json \
  --baseline-metadata protocol/compatibility/firmware-compatibility.json \
  --frozen-contract protocol/baseline/react-native-public-api-0.0.65.json
npm run test:workflows -- --sdk-path "$BOTA_REACT_NATIVE_SDK_PATH" \
  --expected-commit 318974f925a573cf04b0d624978bee04784af09b
npm test --prefix frameworks/react-native
```

The workflow gate executes six referenced maintenance Jest files plus three
focused files for diagnostics decoding, upload recovery, and v2 lost-ACK
reconciliation. Seven scenarios still reference implementation anchors rather
than dedicated maintenance test titles. All 33 have 29 distinct executable Rust
tests. Counts are not claims of exhaustive platform or physical-device parity.
The result reports executed test counts separately so skipped checks cannot be
mistaken for executed evidence.

Verified on 2026-09-24 with Node 22.23.2, TypeScript 6.0.3, and Rust 1.98.0:

- Frozen contract hash unchanged; tooling suite: 117/117 passing.
- Clean pinned reference: 19 Jest suites, 253 tests passing.
- Workflow evidence: 8 suites, 33 scenarios, 29 Rust tests and 9 maintenance
  test files executed successfully, including the source contract check.
- Target RN verification is reported separately by the implementation owner;
  a successful reference-source gate is not a substitute for its runtime tests.

Regression tests were observed failing before implementation for missing
additions checks, stale/mismatched source selection, source/lock/compiler drift,
and incomplete maintenance test-file execution. The old constructor and missing
public recovery exports also produced real target compatibility failures.
