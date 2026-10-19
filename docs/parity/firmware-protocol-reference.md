# Firmware Protocol Reference Coverage Review

Date: October 19, 2026. Initial SDK source baseline: `78c85c0` on `main`;
the documentation branch also incorporates merged naming revision `3cdb474`.
Scope: complete the App-facing firmware reference using the retired React Native
SDK document as a topic checklist and current App SDK source as authority.
No production code, protocol manifest, generated artifact or package changed.

The compound-engineering skill is unavailable in this session. The required
design/conformance comparison is recorded directly below.

| Requirement | Implementation evidence | Conformance | Remaining boundary |
| --- | --- | --- | --- |
| One active SDK-local entry point | Root `FIRMWARE_PROTOCOL.md`, README integration row | Expanded the existing entry; retained marker/find sections and appendices | Documentation is maintained, not emitted by protocol code generation |
| GATT identities and packet values follow current source | `protocol/manifest/device-protocol.yaml`, generated constants, Rust protocol codecs | Documented all service families, status, time sync, settings, legacy transfer and OTA | Discovered UUIDs alone do not establish support or authorization |
| Replace obsolete reset instructions | `docs/parity/factory-reset-authorization.md`, Rust factory-reset workflow | Dedicated 179-byte grant, generation-bearing opcode, durable result before receipt, no destructive replay | Physical wipe and backend finalization acceptance remain separate |
| Explain customer encryption before storage upload | `docs/parity/byo-upload-encryption.md`, `docs/parity/byo-storage.md`, Rust BYO codec, Apple `ByoDeviceSession` | Added version-3 framing and sequence diagram: customer recipient, device key envelope, unchanged ciphertext relay, customer decryption, receipt-gated cleanup | Customer endpoint qualification and hardware end-to-end testing are not established here |
| Preserve ordinary v2 and marked/direct-streaming boundaries | Rust v2/context codecs and workflow; existing marker/stream appendices | Separate context/admission, full UUID, durable ACK and receipt gates; kept detailed marker/find content | No new capability/profile or wire format |
| Describe diagnostic ownership and framing | Rust diagnostics/log codecs, diagnostics parity review | Separate debug logs from structured fault history; exact detail length and explicit event ACK | Firmware build gates and physical subscription behavior require target validation |
| Keep source and publication evidence distinct | Beta.19 publication record; feature parity reviews | Removed root introduction's stale unreleased-runtime/beta.14 framing; retained explicit qualification boundaries | No new release, deployment or hardware acceptance |

## Differences from the Archived Reference

- Shared settings currently encode bytes10..11 as zero. The archived reference's
  explicit `recording_mode` byte10 is not exposed by this shared model; this is a
  pre-existing code/API gap, not a documentation-generated feature.
- The shared SHA256 packet decoder exposes only the digest; the archived
  appended file-reference discussion must not be represented as authenticated
  recording binding by that decoder.
- Reset now requires the dedicated grant/generation contract. Copying the old
  deprovision-grant plus one-byte reset flow would be incorrect.
- BYO version3 uses existing v2 control/data characteristics but its own RPC
  namespace. Customer recipient selection does not require a new content cipher
  or SDK decryption implementation.

## Initial Verification

- Protocol generation freshness passed: `cargo run --offline --quiet -p xtask
  -- protocol generate --check` reports `protocol constants are current`.
- Existing core suites passed: **67 tests across nine suites** (`fixture_encode`,
  `fixture_decode`, `byo_ble`, `byo_upload_recovery`, `factory_reset_workflow`,
  `diagnostics`, `firmware_update_workflow`, `upload_context`,
  `encrypted_upload_v2_codec`). These cover the cited source contracts; no test
  or production implementation was added for the documentation edit.
- `node docs/firmware/vectors/verify.mjs` passed: five pinned fixtures,
  13 signed documents, identity/hash bindings and negative mutations.
- Checked 117 local links/anchors across the four changed documents, English
  text, balanced code fences and `git diff --check`.
- Existing detailed marker, direct-streaming and find sections remain
  byte-for-byte unchanged. The merged `BLE Advertising Name` section is retained
  after them without alteration.

## Main-Branch Integration

Merged `main` revision `3cdb474` into this documentation branch after SDK #42.
The only textual conflict was two independent additions under `Unreleased` in
`CHANGELOG.md`; both the protocol-reference entry and the BLE naming entry are
retained. The standard `<model> <last four SN characters>` contract, reconnect
implementation, regressions and canonical generated core match `main` exactly.
The PR remains documentation-only relative to the current base.
The contents list and README include BLE naming. Merge verification checks local
links, contents anchors, balanced fences, conflict-marker absence and unchanged
marker/find/naming sections against `main`. The existing vector audit passes
again (five fixtures and 13 signed documents); runtime suites are not repeated
for a documentation-only conflict resolution.

No target device, mobile package build, publication or live customer upload is
part of this documentation change. The settings-model and SHA256 binding gaps
above are source differences; they are separate from unavailable physical or
release verification.
