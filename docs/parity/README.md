# Maintenance Parity

## Scope And Status

Unpublished source fixes against `react-native-sdk` revision
`318974f925a573cf04b0d624978bee04784af09b` (`0.0.67`), verified on 2026-09-24:

- [Diagnostics](native-diagnostics.md): explicit read/ACK on Apple, Android and
  RN, backed by a [bounded Rust codec](diagnostics-codec.md). Reading never
  acknowledges events. Malformed RN decoder detail resets its assembly state.
- [Upload recovery](upload-recovery.md): native-owned files, durable non-secret
  metadata, fresh exact-scope credentials, completion-gated deletion, and
  cancellation/restart ownership. Journal replacement and file deletion both
  include a directory durability barrier; failed cleanup remains retryable.
- Lost-WINDOW_ACK reconciliation on [Apple](apple-lost-ack-recovery.md) and
  [Android](android-lost-ack-recovery.md): one locally proved older checkpoint,
  persisted before truncation, with foreign/newer/repeated replies rejected.
- [Maintenance gates](maintenance-baseline.md): explicit additions alongside
  the unchanged frozen 0.0.65 public API, not a blanket equivalence claim.

Published `2.0.0-beta.1` and all application dependencies are unchanged. No
release, remote CI/CD, or physical-device operation was performed for this fix.

## Local Verification

| Gate | Final result |
| --- | --- |
| Rust workspace tests, Clippy with warnings denied, format | Passed |
| Protocol generation check; C and Swift ABI smoke | Passed |
| Apple XCFramework build | Passed |
| Native Apple suite | 226 tests, 9 physical skips, no failures |
| Native Android debug and release suites | 201 each, no failures or skips |
| Android diagnostics through fresh JNI on API 35 | 2 passed |
| Native Android lint, assembly, local Maven artifact | Passed |
| RN verify: tests, Codegen, types, build, licenses | 125 passed; all gates passed |
| RN Swift adapter, strict concurrency and warnings as errors | 42 passed |
| RN CocoaPods consumer build | Passed |
| RN Android adapter against the fresh local native artifact | 41 passed; Codegen, lint and release assembly passed |
| Repository tooling | 117 passed |
| Clean pinned maintenance reference | 19 Jest suites, 253 passed |
| Workflow comparison | 8 suites, 33 scenarios; 29 Rust tests and 9 reference test files executed |

Independent reviews covered codec/typed bridge mapping, diagnostics cleanup,
upload ownership and deletion durability, and native lost-ACK reconciliation.
Their actionable findings were fixed and regression-tested before this report.

## Remaining Boundaries

- `RecordingDataStore` is exported for type compatibility but its legacy JS
  byte callbacks are explicitly rejected. Demo/Bota One need a native-file
  migration and application tests before consuming this source unchanged.
- Eighteen maintenance v2 exports and newer provisioning-result members are
  not asserted equivalent by this focused gate. Web/Flutter diagnostics and
  recovery additions are not implemented by this change.
- Apple v2 transfer-control reset has no production disconnect caller, and
  ID-only queued native operations can race a same-ID replacement connection.
  Existing stream-termination guards do not establish an atomic live lease;
  see the Apple ownership limits. No generic transport rewrite is included.
- Android v2 replay host tests use synthetic opaque core checkpoint bytes;
  real v2 JNI/reducer recovery remains a separate integration gate.
- Hardware BLE/OTA, process-kill recovery, physical power-loss durability,
  backend end-to-end acceptance, and public consumer release tests remain open.
  Retry scheduling needs a live JS runtime. Runtime compatibility metadata
  remains `contract_only`; no firmware capability is enabled by these tests.
