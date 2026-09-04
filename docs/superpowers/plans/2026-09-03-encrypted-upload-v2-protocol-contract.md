# Encrypted Upload v2 Protocol Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land one executable, machine-readable Encrypted Upload v2 contract
across the canonical App SDK, the maintenance React Native SDK, the backend,
and a non-production firmware reference decoder without enabling any runtime
upload path or firmware capability.

**Architecture:** `app-sdk` owns the manifest, Rust codecs, and deterministic
golden-vector bundle. Apple, Android, the App SDK React Native adapter, the
maintenance `react-native-sdk`, the backend, and firmware host tests consume
that exact bundle and pin its source revision and SHA-256; none may edit its
bytes locally. Contract inspection is additive and internal, so released v1
and P10 behavior, public SDK surfaces, backend routes, firmware GATT tables,
and production capability advertising remain unchanged.

**Tech Stack:** Rust 1.98 / edition 2024, Cargo xtask, RustCrypto
(`hpke` 0.14.0, `p256` 0.14.0, `chacha20poly1305` 0.11.0, `hmac` 0.13.0,
`rand_chacha` 0.10.0, `sha2` 0.11.0), Swift 6 / XCTest, Kotlin 2.1.20 /
JUnit 4, TypeScript 5/6, Node.js 20+/22, Jest 30, Vitest 4, Python 3.9+
with `cryptography` 50.0.1 for host-only firmware conformance tests.

**Spec:**
`docs/superpowers/specs/2026-09-03-encrypted-upload-v2-protocol-contract-design.md`

## Global Constraints

- This milestone is contract-only. Do not add a public backend endpoint,
  decryption/publication worker, SDK upload workflow, firmware runtime parser,
  storage writer, GATT attribute, or advertised capability bit.
- Batch v2 is defined; live streaming v2 is not. A durably applied
  `v2_required` policy rejects legacy batch completion and legacy streaming
  chunk/finalization entry points.
- `app-sdk/protocol/manifest/device-protocol.yaml` is the canonical wire source.
  Keep its released `protocolRevision` tied to the existing firmware baseline;
  add a separate `encrypted-upload-v2-contract-v1` contract revision so the
  unimplemented firmware is never reported as supporting v2.
- The canonical vector is
  `app-sdk/protocol/vectors/encrypted-upload-v2.json`. Every copied bundle must
  be read from a committed App SDK revision with `git show`, accompanied by
  that revision and the source SHA-256, and rejected if its digest changes.
- Keep `protocol/fixtures/` and the frozen React Native `0.0.65` fixture digest
  unchanged. V2 vectors live under `protocol/vectors/`, outside the released
  v1/P10 compatibility suite.
- All integers are unsigned little-endian unless the spec names an RFC
  encoding. Reject trailing bytes, nonzero reserved bytes/bits, unknown
  versions/suites/critical flags, inconsistent declared lengths, and checked
  arithmetic overflow.
- App SDKs never construct `UploadAuthorizationV2`, decrypt recordings, or call
  the Bota control plane. They treat authorization, manifest, receipt, and
  ciphertext payloads as opaque after structural framing checks.
- In `app-sdk`, recording bytes stay in native sinks. No ciphertext,
  authorization, manifest, or receipt byte array may be added to the React
  Native Codegen contract.
- In `react-native-sdk`, v2 codecs stay internal and unexported in this
  milestone. Existing `react-native-ble-plx` notifications may eventually
  carry opaque bytes, but no manager selects or starts v2 here.
- `BACKEND_PUBKEY`, the legacy recording-list encrypted flag, and historical
  P10 `E2E_START` must never select `encrypted_upload_v2`.
- Contract parsers return an error value only. They have no recording-delete,
  legacy-fallback, upload-start, or CONFIRM side effect, so every v2 failure in
  this milestone necessarily retains the device recording.
- Preserve pre-existing uncommitted `app-sdk/AGENTS.md`,
  `app-sdk/ARCHITECTURE.md`, and `bota/infra/CLAUDE.md` changes. Stage only
  task-owned paths or task-owned hunks.
- Every App SDK commit includes
  `Co-Authored-By: OpenAI Codex <noreply@openai.com>`.
- Every code commit includes a documentation or tracked-plan update in the
  same repository. Public `docs/` stays unchanged because this milestone adds
  no released API or runtime behavior.

## File and Ownership Map

| Repository | Files | Responsibility |
|---|---|---|
| `app-sdk` | `protocol/manifest/device-protocol.yaml`, `tools/xtask/src/protocol.rs`, `core/device-sdk-core/src/generated/protocol.rs` | Canonical UUIDs, constants, lengths, offsets, flags, and stable result codes |
| `app-sdk` | `core/device-sdk-core/src/protocol/encrypted_upload_v2.rs`, `core/device-sdk-core/tests/encrypted_upload_v2_codec.rs` | Bounds-checked document and BLE framing codecs; no key ownership or decryption |
| `app-sdk` | `tools/xtask/src/encrypted_upload_v2.rs`, `protocol/vectors/encrypted-upload-v2.{schema.json,json}`, `core/device-sdk-core/src/generated/encrypted_upload_v2_vectors.rs` | Deterministic non-production crypto and framing vectors plus bundle digest |
| `app-sdk` | `bindings/device-sdk-ffi/{src/packet.rs,src/protocol.rs,include/bota_device_sdk.h}` | Additive ABI v1 contract-inspection packet kinds and fields |
| `app-sdk` | `platforms/apple/**`, `platforms/android/**` | Native normalized-value conformance over the shared Rust core and exact vector resource |
| `app-sdk` | `frameworks/react-native/test/**`, `protocol/compatibility/firmware-compatibility.json` | Prove the bridge stays byte-free and v2 remains contract-only / unsupported at runtime |
| `react-native-sdk` | `protocol/vendor/app-sdk/**`, `scripts/sync-encrypted-upload-v2-vectors.mjs`, `src/protocol/encryptedUploadV2.ts`, `__tests__/encryptedUploadV2.test.ts` | Vendored exact vector and internal transitional TypeScript codecs |
| `bota` | `api/tests/fixtures/encrypted-upload-v2/**`, `api/scripts/sync-encrypted-upload-v2-vectors.mjs`, `api/src/utils/encrypted-upload-v2-contract.ts`, `api/tests/unit/encrypted-upload-v2-contract.test.ts` | Testable backend parser/crypto verifier with no route or worker registration |
| `firmware` | `scripts/fixtures/encrypted-upload-v2/**`, `scripts/encrypted_upload_v2_reference.py`, `scripts/test_encrypted_upload_v2_contract.py` | Host-only structural and crypto reference; production C remains untouched |
| `internal-docs` | `device/Encrypted-Upload-v2.md`, `device/FIRMWARE_INTEGRATION_GUIDE.md`, `device/BLE Reliable Transfer Design.md`, `System Design v5.md`, `CLAUDE.md`, `llms.txt`, `llms-full.txt` | Normative tables, ownership, contract-frozen/runtime-disabled status, and downstream index |

---

### Task 1: Extend the Canonical Manifest and Generator

**Files:**
- Modify: `app-sdk/protocol/manifest/device-protocol.yaml`
- Modify: `app-sdk/tools/xtask/src/protocol.rs`
- Modify: `app-sdk/tools/xtask/tests/protocol_codegen.rs`
- Modify: `app-sdk/core/device-sdk-core/src/generated/protocol.rs`
- Modify: `app-sdk/docs/superpowers/specs/2026-09-03-encrypted-upload-v2-protocol-contract-design.md`
- Modify: `app-sdk/docs/superpowers/plans/2026-09-03-encrypted-upload-v2-protocol-contract.md`
- Modify: `app-sdk/docs/superpowers/plans/2026-08-30-native-abi-foundation.md`

**Interfaces:**
- Consumes: the exact allocations and lengths in the design spec §§ Binary
  Conventions, Storage Object, Authorization, Manifest, Receipt, Bluetooth
  Allocation, and Stable Result and Error Codes.
- Produces: generated `u8`, `u16`, `u32`, byte-string, layout length, field
  offset, and field width constants used by Tasks 2-8.
- Produces: `ENCRYPTED_UPLOAD_V2_CONTRACT_REVISION` equal to
  `"encrypted-upload-v2-contract-v1"`; it does not change released
  `PROTOCOL_REVISION`.

- [x] **Step 1: Write the generator assertions before changing the manifest**

Add these assertions to `tools/xtask/tests/protocol_codegen.rs`:

```rust
#[test]
fn generated_encrypted_upload_v2_contract_is_complete() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let generated = xtask::protocol::generated_content(&root).unwrap();
    for expected in [
        "ENCRYPTED_UPLOAD_V2_CONTRACT_REVISION: &str = \"encrypted-upload-v2-contract-v1\"",
        "CHAR_STORAGE_TRANSFER_CAPABILITIES_V2: &str = \"B07A0004-0006-1000-8000-00805F9B34FB\"",
        "CHAR_TRANSFER_SIGNED_BLOB_V2: &str = \"B07A0004-0007-1000-8000-00805F9B34FB\"",
        "CHAR_TRANSFER_CONTROL_V2: &str = \"B07A0004-0008-1000-8000-00805F9B34FB\"",
        "CHAR_RECORDING_TRANSFER_V2: &str = \"B07A0004-0009-1000-8000-00805F9B34FB\"",
        "CHAR_TRANSFER_STATUS_V2: &str = \"B07A0004-000A-1000-8000-00805F9B34FB\"",
        "CHAR_RECORDING_LIST_V2: &str = \"B07A0004-000B-1000-8000-00805F9B34FB\"",
        "ENCRYPTED_UPLOAD_V2_STORAGE_HEADER_FIXED_LENGTH: usize = 128",
        "ENCRYPTED_UPLOAD_V2_STORAGE_TRAILER_FIXED_LENGTH: usize = 144",
        "UPLOAD_AUTHORIZATION_V2_FIXED_LENGTH: usize = 408",
        "UPLOAD_MANIFEST_V2_FIXED_LENGTH: usize = 580",
        "COMPLETION_RECEIPT_V2_FIXED_LENGTH: usize = 336",
        "ENCRYPTED_UPLOAD_V2_DOMAIN_HPKE_KEY_EXPORT: &[u8] = b\"bota/enc-v2/hpke-key-export/v1\"",
        "ENCRYPTED_UPLOAD_V2_CAPABILITY_FIXED_LENGTH: usize = 24",
        "ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_FIXED_LENGTH: usize = 96",
        "ENCRYPTED_UPLOAD_V2_START_FIXED_LENGTH: usize = 128",
        "ENCRYPTED_UPLOAD_V2_START_ACK_FIXED_LENGTH: usize = 140",
        "ENCRYPTED_UPLOAD_V2_WINDOW_END_FIXED_LENGTH: usize = 68",
        "ENCRYPTED_UPLOAD_V2_EOF_FIXED_LENGTH: usize = 92",
        "ENCRYPTED_UPLOAD_V2_RESUME_FIXED_LENGTH: usize = 96",
        "ENCRYPTED_UPLOAD_V2_CONFIRM_FIXED_LENGTH: usize = 84",
        "ENCRYPTED_UPLOAD_V2_STATUS_FIXED_LENGTH: usize = 24",
    ] {
        assert!(generated.contains(expected), "missing {expected}");
    }
}
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd /Users/zhangqi/ws/bota/app-sdk
cargo test -p xtask --test protocol_codegen generated_encrypted_upload_v2_contract_is_complete
```

Expected: FAIL because the contract revision, characteristics, and layouts are
absent.

- [x] **Step 3: Add typed manifest sections and validation**

Extend `ProtocolManifest` and generation with these exact optional maps so
existing manifests remain source-compatible while the v2 contract can express
values wider than one byte:

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProtocolManifest {
    schema_version: u32,
    protocol_revision: String,
    #[serde(default)]
    contract_revisions: BTreeMap<String, String>,
    services: Vec<Service>,
    constant_groups: BTreeMap<String, BTreeMap<String, u8>>,
    #[serde(default)]
    word_constant_groups: BTreeMap<String, BTreeMap<String, u16>>,
    #[serde(default)]
    dword_constant_groups: BTreeMap<String, BTreeMap<String, u32>>,
    #[serde(default)]
    byte_strings: BTreeMap<String, String>,
    #[serde(default)]
    ascii_strings: BTreeMap<String, String>,
    layouts: BTreeMap<String, Layout>,
    limits: BTreeMap<String, usize>,
}
```

Validate contract-revision keys with `require_constant_name`, require nonempty
revision strings, require every `byteStrings` value to be lowercase even-length
hex, reject NUL/non-ASCII in `asciiStrings`, and include all new names in the
existing uniqueness set. Generate these forms:

```rust
pub const ENCRYPTED_UPLOAD_V2_CONTRACT_REVISION: &str =
    "encrypted-upload-v2-contract-v1";
pub const ENCRYPTED_UPLOAD_V2_RESULT_SUCCESS: u16 = 0x0000;
pub const ENCRYPTED_UPLOAD_V2_CAP_TRANSFER_FRAMING: u32 = 1 << 0;
pub const ENCRYPTED_UPLOAD_V2_STORAGE_MAGIC: &[u8] = b"BOTAENC2";
pub const ENCRYPTED_UPLOAD_V2_START_SESSION_ID_OFFSET: usize = 4;
```

- [x] **Step 4: Add every frozen value to the manifest**

Keep `protocolRevision: firmware-8b175a89374c`. Add
`contractRevisions.ENCRYPTED_UPLOAD_V2_CONTRACT_REVISION`, characteristics
`0406` through `040B`, and the following constant groups:

```yaml
contractRevisions:
  ENCRYPTED_UPLOAD_V2_CONTRACT_REVISION: encrypted-upload-v2-contract-v1

wordConstantGroups:
  encrypted_upload_v2_suites:
    ENCRYPTED_UPLOAD_V2_STORAGE_SUITE_CHACHA20_POLY1305_HKDF_SHA256_HMAC_SHA256: 1
    ENCRYPTED_UPLOAD_V2_LOCAL_WRAP_SUITE_CHACHA20_POLY1305_HKDF_SHA256: 1
    ENCRYPTED_UPLOAD_V2_AUTH_SUITE_HMAC_SHA256: 1
    ENCRYPTED_UPLOAD_V2_SIGNATURE_SUITE_P256_SHA256_P1363_LOW_S: 1
    ENCRYPTED_UPLOAD_V2_HPKE_KEM_X25519_HKDF_SHA256: 32
    ENCRYPTED_UPLOAD_V2_HPKE_KDF_HKDF_SHA256: 1
    ENCRYPTED_UPLOAD_V2_HPKE_AEAD_CHACHA20_POLY1305: 3
  encrypted_upload_v2_results:
    ENCRYPTED_UPLOAD_V2_RESULT_SUCCESS: 0
    ENCRYPTED_UPLOAD_V2_RESULT_UNSUPPORTED_VERSION: 1
    ENCRYPTED_UPLOAD_V2_RESULT_INVALID_LENGTH: 2
    ENCRYPTED_UPLOAD_V2_RESULT_NONCANONICAL_ENCODING: 3
    ENCRYPTED_UPLOAD_V2_RESULT_SIGNATURE_INVALID: 4
    ENCRYPTED_UPLOAD_V2_RESULT_ENVIRONMENT_MISMATCH: 5
    ENCRYPTED_UPLOAD_V2_RESULT_EXPIRED: 6
    ENCRYPTED_UPLOAD_V2_RESULT_TIME_UNAVAILABLE: 7
    ENCRYPTED_UPLOAD_V2_RESULT_IDENTITY_MISMATCH: 8
    ENCRYPTED_UPLOAD_V2_RESULT_BINDING_GENERATION_MISMATCH: 9
    ENCRYPTED_UPLOAD_V2_RESULT_RECORDING_IDENTITY_MISMATCH: 10
    ENCRYPTED_UPLOAD_V2_RESULT_STORAGE_SUITE_UNSUPPORTED: 11
    ENCRYPTED_UPLOAD_V2_RESULT_DOWNGRADE_PROHIBITED: 12
    ENCRYPTED_UPLOAD_V2_RESULT_AUTHORIZATION_MISMATCH: 13
    ENCRYPTED_UPLOAD_V2_RESULT_OWNER_BUSY: 14
    ENCRYPTED_UPLOAD_V2_RESULT_CHECKPOINT_MISMATCH: 15
    ENCRYPTED_UPLOAD_V2_RESULT_RECEIPT_MISMATCH: 16
    ENCRYPTED_UPLOAD_V2_RESULT_MIXED_PROFILE: 17
    ENCRYPTED_UPLOAD_V2_RESULT_CIPHERTEXT_UNAVAILABLE: 18
    ENCRYPTED_UPLOAD_V2_RESULT_REPLAY_CONFLICT: 19
    ENCRYPTED_UPLOAD_V2_RESULT_INTERNAL: 255

dwordConstantGroups:
  encrypted_upload_v2_capability_flags:
    ENCRYPTED_UPLOAD_V2_CAP_TRANSFER_FRAMING: 1
    ENCRYPTED_UPLOAD_V2_CAP_STORAGE: 2
    ENCRYPTED_UPLOAD_V2_CAP_FULL_RECORDING_IDENTITY: 4
    ENCRYPTED_UPLOAD_V2_CAP_DURABLE_RESUME: 8
    ENCRYPTED_UPLOAD_V2_CAP_AUTHENTICATED_MANIFEST: 16
    ENCRYPTED_UPLOAD_V2_CAP_AUTHENTICATED_RECEIPT: 32
    ENCRYPTED_UPLOAD_V2_CAP_BATCH: 64
    ENCRYPTED_UPLOAD_V2_CAP_STREAMING: 128

byteStrings:
  ENCRYPTED_UPLOAD_V2_STORAGE_MAGIC: 424f5441454e4332
  ENCRYPTED_UPLOAD_V2_TRAILER_MAGIC: 424f5441454e4432
  UPLOAD_AUTHORIZATION_V2_MAGIC: 424f544141555432
  UPLOAD_MANIFEST_V2_MAGIC: 424f54414d4e4632
  COMPLETION_RECEIPT_V2_MAGIC: 424f544152435054

asciiStrings:
  ENCRYPTED_UPLOAD_V2_DOMAIN_LOCAL_WRAP: bota/enc-v2/local-wrap/v1
  ENCRYPTED_UPLOAD_V2_DOMAIN_WRAPPED_KEY_AAD: bota/enc-v2/wrapped-key-aad/v1
  ENCRYPTED_UPLOAD_V2_DOMAIN_BLOCK_AAD: bota/enc-v2/block-aad/v1
  ENCRYPTED_UPLOAD_V2_DOMAIN_TRAILER_KEY: bota/enc-v2/trailer-key/v1
  ENCRYPTED_UPLOAD_V2_DOMAIN_TRAILER_AUTH: bota/enc-v2/trailer-auth/v1
  ENCRYPTED_UPLOAD_V2_DOMAIN_MANIFEST_KEY: bota/enc-v2/manifest-key/v1
  ENCRYPTED_UPLOAD_V2_DOMAIN_MANIFEST_AUTH: bota/enc-v2/manifest-auth/v1
  ENCRYPTED_UPLOAD_V2_DOMAIN_STORAGE_IDENTITY: bota/enc-v2/storage-identity/v1
  ENCRYPTED_UPLOAD_V2_DOMAIN_UPLOAD_CONTEXT: bota/enc-v2/upload-context/v1
  ENCRYPTED_UPLOAD_V2_DOMAIN_HPKE_KEY_EXPORT: bota/enc-v2/hpke-key-export/v1
  ENCRYPTED_UPLOAD_V2_DOMAIN_DEVICE_IDENTITY: bota/enc-v2/device-identity/v1
  ENCRYPTED_UPLOAD_V2_DOMAIN_TENANT_CONTEXT: bota/enc-v2/tenant-context/v1
  ENCRYPTED_UPLOAD_V2_DOMAIN_STAGING_OBJECT: bota/enc-v2/staging-object/v1
  ENCRYPTED_UPLOAD_V2_DOMAIN_PUBLICATION: bota/enc-v2/publication/v1
```

Add these exact `u8` groups and add
`BLE_ERROR_ENCRYPTED_UPLOAD_V2_REQUIRED: 0x22` to the existing `ble_errors`
group:

```yaml
  encrypted_upload_profiles:
    UPLOAD_PROFILE_LEGACY_PLAIN_V1: 1
    UPLOAD_PROFILE_LEGACY_P10_RELAY: 2
    UPLOAD_PROFILE_ENCRYPTED_UPLOAD_V2: 3
  encrypted_upload_storage_formats:
    STORAGE_FORMAT_LEGACY_PLAIN: 1
    STORAGE_FORMAT_BOTA_ENC_V1: 2
    STORAGE_FORMAT_BOTA_ENC_V2: 3
  encrypted_upload_policies:
    ENCRYPTED_UPLOAD_POLICY_LEGACY_ALLOWED: 0
    ENCRYPTED_UPLOAD_POLICY_V2_PREFERRED: 1
    ENCRYPTED_UPLOAD_POLICY_V2_REQUIRED: 2
  encrypted_upload_channels:
    ENCRYPTED_UPLOAD_CHANNEL_BLE: 1
    ENCRYPTED_UPLOAD_CHANNEL_WIFI: 2
    ENCRYPTED_UPLOAD_CHANNEL_CELLULAR: 3
  encrypted_upload_environments:
    ENCRYPTED_UPLOAD_ENVIRONMENT_DEVELOPMENT: 0
    ENCRYPTED_UPLOAD_ENVIRONMENT_GAMMA: 1
    ENCRYPTED_UPLOAD_ENVIRONMENT_PRODUCTION: 2
  encrypted_upload_v2_blob_kinds:
    ENCRYPTED_UPLOAD_V2_BLOB_KIND_AUTHORIZATION: 1
    ENCRYPTED_UPLOAD_V2_BLOB_KIND_RECEIPT: 2
  encrypted_upload_v2_blob_messages:
    ENCRYPTED_UPLOAD_V2_BLOB_BEGIN: 96
    ENCRYPTED_UPLOAD_V2_BLOB_DATA: 97
    ENCRYPTED_UPLOAD_V2_BLOB_COMMIT: 98
    ENCRYPTED_UPLOAD_V2_BLOB_ABORT: 99
    ENCRYPTED_UPLOAD_V2_BLOB_RESULT: 100
  encrypted_upload_v2_transfer_messages:
    ENCRYPTED_UPLOAD_V2_START: 32
    ENCRYPTED_UPLOAD_V2_WINDOW_ACK: 33
    ENCRYPTED_UPLOAD_V2_RESUME_REQUEST: 34
    ENCRYPTED_UPLOAD_V2_CONFIRM: 35
    ENCRYPTED_UPLOAD_V2_ABORT: 36
    ENCRYPTED_UPLOAD_V2_LIST: 37
    ENCRYPTED_UPLOAD_V2_START_ACK: 64
    ENCRYPTED_UPLOAD_V2_DATA: 65
    ENCRYPTED_UPLOAD_V2_WINDOW_END: 66
    ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK: 67
    ENCRYPTED_UPLOAD_V2_EOF: 68
    ENCRYPTED_UPLOAD_V2_RESUME_ACCEPT: 69
    ENCRYPTED_UPLOAD_V2_RESUME_REJECT: 70
    ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY: 72
    ENCRYPTED_UPLOAD_V2_RECORDING_LIST_END: 73
    ENCRYPTED_UPLOAD_V2_ERROR: 79
  encrypted_upload_v2_status_phases:
    ENCRYPTED_UPLOAD_V2_PHASE_IDLE: 0
    ENCRYPTED_UPLOAD_V2_PHASE_RECEIVING_AUTHORIZATION: 1
    ENCRYPTED_UPLOAD_V2_PHASE_AUTHORIZED: 2
    ENCRYPTED_UPLOAD_V2_PHASE_TRANSFERRING: 3
    ENCRYPTED_UPLOAD_V2_PHASE_WAITING_WINDOW_ACK: 4
    ENCRYPTED_UPLOAD_V2_PHASE_SENDING_FINAL_EVIDENCE: 5
    ENCRYPTED_UPLOAD_V2_PHASE_WAITING_BACKEND_COMPLETION: 6
    ENCRYPTED_UPLOAD_V2_PHASE_RECEIVING_RECEIPT: 7
    ENCRYPTED_UPLOAD_V2_PHASE_CONFIRMING: 8
    ENCRYPTED_UPLOAD_V2_PHASE_COMPLETE: 9
    ENCRYPTED_UPLOAD_V2_PHASE_ERROR: 10
  encrypted_upload_v2_versions_and_modes:
    ENCRYPTED_UPLOAD_V2_CAPABILITY_ENCODING_VERSION: 1
    ENCRYPTED_UPLOAD_V2_TRANSFER_PROFILE_VERSION: 2
    ENCRYPTED_UPLOAD_V2_DOCUMENT_VERSION: 2
    ENCRYPTED_UPLOAD_V2_COMPLETION_COMPLETE: 1
    ENCRYPTED_UPLOAD_V2_MODE_BATCH: 1
    ENCRYPTED_UPLOAD_V2_MODE_STREAMING: 2
```

Add the exact layouts and offsets from the spec for:

```text
ENCRYPTED_UPLOAD_V2_STORAGE_HEADER 128
ENCRYPTED_UPLOAD_V2_STORAGE_BLOCK_HEADER 4
ENCRYPTED_UPLOAD_V2_STORAGE_TRAILER 144
UPLOAD_AUTHORIZATION_V2 408
UPLOAD_MANIFEST_V2 580
COMPLETION_RECEIPT_V2 336
ENCRYPTED_UPLOAD_V2_CAPABILITY 24
ENCRYPTED_UPLOAD_V2_BLOB_BEGIN 42
ENCRYPTED_UPLOAD_V2_BLOB_DATA 12+N
ENCRYPTED_UPLOAD_V2_BLOB_COMMIT 8
ENCRYPTED_UPLOAD_V2_BLOB_ABORT 8
ENCRYPTED_UPLOAD_V2_BLOB_RESULT 10
ENCRYPTED_UPLOAD_V2_COMMON_HEADER 12
ENCRYPTED_UPLOAD_V2_LIST 16
ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY 96
ENCRYPTED_UPLOAD_V2_RECORDING_LIST_END 52
ENCRYPTED_UPLOAD_V2_START 128
ENCRYPTED_UPLOAD_V2_START_ACK 140
ENCRYPTED_UPLOAD_V2_DATA 28+N
ENCRYPTED_UPLOAD_V2_WINDOW_END 68
ENCRYPTED_UPLOAD_V2_WINDOW_ACK 68+4*N
ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK 52+N
ENCRYPTED_UPLOAD_V2_EOF 92
ENCRYPTED_UPLOAD_V2_RESUME 96
ENCRYPTED_UPLOAD_V2_RESUME_REJECT 60
ENCRYPTED_UPLOAD_V2_CONFIRM 84
ENCRYPTED_UPLOAD_V2_ABORT 16
ENCRYPTED_UPLOAD_V2_ERROR 20
ENCRYPTED_UPLOAD_V2_STATUS 24
```

For every manifest field, generate `LAYOUT_NAME_FIELD_NAME_OFFSET` and
`LAYOUT_NAME_FIELD_NAME_WIDTH`; a width of zero means an explicitly length-delimited
tail and never an unbounded allocation.

- [x] **Step 5: Generate and verify the constants**

Run:

```bash
cargo xtask protocol generate
cargo xtask protocol generate --check
cargo test -p xtask --test protocol_codegen
cargo fmt --all -- --check
```

Expected: all commands PASS and a second generation changes no file.

- [x] **Step 6: Commit only the manifest/generator slice**

Mark Task 1 checked in this plan, then run:

```bash
git add protocol/manifest/device-protocol.yaml \
  tools/xtask/src/protocol.rs \
  tools/xtask/tests/protocol_codegen.rs \
  core/device-sdk-core/src/generated/protocol.rs \
  docs/superpowers/specs/2026-09-03-encrypted-upload-v2-protocol-contract-design.md \
  docs/superpowers/plans/2026-09-03-encrypted-upload-v2-protocol-contract.md
git diff --cached --check
git commit -m "feat: freeze encrypted upload v2 wire constants" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

Expected: the pre-existing `AGENTS.md` and `ARCHITECTURE.md` changes are not
staged.

---

### Task 2: Add Bounds-Checked Rust Contract Codecs

**Files:**
- Create: `app-sdk/core/device-sdk-core/src/protocol/encrypted_upload_v2.rs`
- Create: `app-sdk/core/device-sdk-core/tests/encrypted_upload_v2_codec.rs`
- Modify: `app-sdk/core/device-sdk-core/Cargo.toml`
- Modify: `app-sdk/Cargo.lock`
- Modify: `app-sdk/core/device-sdk-core/src/protocol/mod.rs`
- Modify: `app-sdk/core/device-sdk-core/src/protocol/cursor.rs`
- Modify: `app-sdk/docs/superpowers/plans/2026-09-03-encrypted-upload-v2-protocol-contract.md`

**Interfaces:**
- Consumes: generated constants from Task 1 and existing `DeviceSdkError`.
- Produces: `decode_encrypted_upload_v2_capabilities`,
  `decode_encrypted_upload_v2_signed_blob`,
  `encode_encrypted_upload_v2_signed_blob`,
  `decode_encrypted_upload_v2_transfer`,
  `encode_encrypted_upload_v2_transfer`, and
  `decode_encrypted_upload_v2_status`.
- Produces: typed `EncryptedUploadV2SignedBlob` and
  `EncryptedUploadV2Transfer` enums. Byte-bearing fields borrow `&[u8]` on
  decode and are copied only by an explicit encoder call. Authorization,
  manifest, receipt, storage-object, and DATA payload bytes remain opaque to
  shipping SDK workflows; full document reference parsing stays in the
  non-shipping xtask and backend/firmware references.

- [x] **Step 1: Add exact-length and canonicality tests first**

Create `encrypted_upload_v2_codec.rs` with a table-driven length gate:

```rust
#[test]
fn fixed_frames_reject_every_truncation_and_one_byte_extension() {
    for (kind, valid) in valid_fixed_frames() {
        for end in 0..valid.len() {
            assert!(decode_fixed_frame(kind, &valid[..end]).is_err());
        }
        let mut extended = valid.clone();
        extended.push(0);
        assert!(decode_fixed_frame(kind, &extended).is_err());
        assert!(decode_fixed_frame(kind, &valid).is_ok());
    }
}

#[test]
fn reserved_bytes_and_unknown_critical_bits_are_rejected() {
    let mut capability = valid_capability();
    capability[22] = 1;
    assert_noncanonical(decode_encrypted_upload_v2_capabilities(&capability));

    let mut abort = valid_abort();
    abort[14] = 1;
    assert_noncanonical(decode_encrypted_upload_v2_transfer(&abort));
}
```

`FixedFrameKind` is a test-only enum for capability, transfer status,
signed-blob fixed frames, and fixed transfer frames; `decode_fixed_frame`
dispatches to the public decoder for that kind. The helpers return deterministic
byte arrays containing the exact spec version, lengths, UUIDs, generations,
flags, and zeroed reserved regions. Add separate assertions for capability,
transfer status, BLOB_BEGIN, BLOB_COMMIT, BLOB_ABORT, BLOB_RESULT, LIST,
RECORDING_ENTRY, RECORDING_LIST_END, START, START_ACK, WINDOW_END, EOF,
RESUME_REQUEST, RESUME_ACCEPT, RESUME_REJECT, CONFIRM, ABORT, and ERROR.

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
cargo test -p bota-device-sdk-core --test encrypted_upload_v2_codec
```

Expected: FAIL because the module and functions do not exist.

- [x] **Step 3: Extend the cursor with checked `u64` and exact-length helpers**

Add only these reusable primitives:

```rust
pub(super) fn u64_le(&self, offset: usize) -> Result<u64, DeviceSdkError> {
    let bytes = self.slice(offset, 8)?;
    Ok(u64::from_le_bytes(bytes.try_into().expect("slice length is checked")))
}

pub(super) fn require_exact(&self, expected: usize) -> Result<(), DeviceSdkError> {
    self.require(expected)?;
    if self.len() != expected {
        return Err(DeviceSdkError::new(
            ErrorCode::InvalidInput,
            Operation::Decode,
            false,
        ).with_detail(format!("packet requires exactly {expected} bytes but has {}", self.len())));
    }
    Ok(())
}
```

- [x] **Step 4: Define the typed contract vocabulary**

Use these public top-level shapes; their fields map one-for-one to the BLE
framing spec and use fixed arrays for UUIDs and digests:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EncryptedUploadV2Capabilities {
    pub flags: u32,
    pub maximum_signed_blob_bytes: u16,
    pub maximum_manifest_bytes: u16,
    pub maximum_data_payload_bytes: u16,
    pub maximum_window_packets: u16,
    pub durable_checkpoint_interval_blocks: u32,
    pub maximum_missing_sequences: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EncryptedUploadV2SignedBlob<'a> {
    Begin { kind: u8, write_id: u32, total_length: u16, sha256: [u8; 32] },
    Data { kind: u8, write_id: u32, offset: u16, data: &'a [u8] },
    Commit { kind: u8, write_id: u32 },
    Abort { kind: u8, write_id: u32 },
    Result { kind: u8, write_id: u32, result: u16 },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EncryptedUploadV2Transfer<'a> {
    List(CommonHeaderV2),
    RecordingEntry(RecordingEntryV2),
    RecordingListEnd { common: CommonHeaderV2, count: u32, list_sha256: [u8; 32] },
    Start(StartV2),
    StartAck(StartAckV2),
    Data { common: CommonHeaderV2, sequence: u32, offset: u64, data: &'a [u8] },
    WindowEnd(WindowEndV2),
    WindowAck(WindowAckV2),
    ManifestChunk(ManifestChunkV2<'a>),
    Eof(EofV2),
    ResumeRequest(ResumeV2),
    ResumeAccept(ResumeV2),
    ResumeReject(ResumeRejectV2),
    Confirm(ConfirmV2),
    Abort { common: CommonHeaderV2, reason: u16 },
    Error {
        common: CommonHeaderV2,
        result: u16,
        failed_message_type: u8,
        checkpoint_revision: u32,
    },
}
```

`CommonHeaderV2` contains `message_type: u8`, `flags: u16`, and nonzero
`transport_session_id: u64`. `WindowAckV2` owns `Vec<u32>` only after checking
`missing_count * 4`, the declared maximum, and the containing frame length.

- [x] **Step 5: Implement the minimal structural codecs**

Implement exact decode/encode pairs using generated offsets. Centralize the
shared rules in these private helpers:

```rust
fn require_zero(bytes: &[u8], field: &'static str) -> Result<(), DeviceSdkError>;
fn require_known_bits(value: u32, known: u32, field: &'static str) -> Result<(), DeviceSdkError>;
fn fixed<const N: usize>(cursor: &Cursor<'_>, offset: usize) -> Result<[u8; N], DeviceSdkError>;
fn checked_frame_length(base: usize, count: usize, width: usize) -> Result<usize, DeviceSdkError>;
fn decode_common(bytes: &[u8], expected_message: u8) -> Result<CommonHeaderV2, DeviceSdkError>;
```

Map structural failures to existing stable SDK errors:

```text
short input                         truncated_packet / decode
trailing input or length mismatch  invalid_input / decode
unknown message/version/suite      unknown_packet / decode
reserved byte or unknown flag      invalid_input / decode
oversize count/payload              payload_too_large / decode
zero transport-session ID          invalid_input / decode
encoder invariant violation         invalid_input / encode
```

The SDK codec verifies embedded SHA-256 values only when the frame contains the
bytes they cover, such as signed-blob reassembly. It does not parse manifest or
authorization fields, verify backend signatures, unwrap `K_data`, decapsulate
HPKE, or authenticate a manifest.

- [x] **Step 6: Add malformed matrices and round-trip tests**

Use one loop per variable frame:

```rust
#[test]
fn window_ack_count_must_match_the_exact_tail() {
    let valid = valid_window_ack(&[7, 11]);
    assert_round_trip_transfer(&valid);
    for declared in [0_u16, 1, 3, u16::MAX] {
        if declared == 2 { continue; }
        let mut invalid = valid.clone();
        invalid[64..66].copy_from_slice(&declared.to_le_bytes());
        assert!(decode_encrypted_upload_v2_transfer(&invalid).is_err());
    }
}
```

Also cover DATA payload length, MANIFEST_CHUNK bounds, duplicate/out-of-order
signed-blob chunks through a small `SignedBlobAssemblerV2`, zero session IDs,
unknown flags, mixed v1/P10 message bytes, `usize` overflow, and every fixed
frame's version/length/reserved fields.

- [x] **Step 7: Run core verification and commit**

Run:

```bash
cargo fmt --all
cargo test -p bota-device-sdk-core --test encrypted_upload_v2_codec
cargo test -p bota-device-sdk-core
cargo clippy -p bota-device-sdk-core --all-targets -- -D warnings
```

Mark Task 2 checked in the plan, then commit:

```bash
git add Cargo.lock core/device-sdk-core/Cargo.toml \
  core/device-sdk-core/src/protocol/cursor.rs \
  core/device-sdk-core/src/protocol/encrypted_upload_v2.rs \
  core/device-sdk-core/src/protocol/mod.rs \
  core/device-sdk-core/tests/encrypted_upload_v2_codec.rs \
  docs/superpowers/plans/2026-09-03-encrypted-upload-v2-protocol-contract.md
git diff --cached --check
git commit -m "feat: add encrypted upload v2 contract codecs" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

---

### Task 3: Generate the Canonical Crypto and Framing Vector Bundle

**Files:**
- Create: `app-sdk/tools/xtask/src/encrypted_upload_v2.rs`
- Create: `app-sdk/tools/xtask/tests/encrypted_upload_v2_vectors.rs`
- Create: `app-sdk/tools/baseline/encrypted-upload-v2-vector-contract.test.mjs`
- Create: `app-sdk/protocol/vectors/encrypted-upload-v2.schema.json`
- Create: `app-sdk/protocol/vectors/encrypted-upload-v2.json`
- Create: `app-sdk/core/device-sdk-core/src/generated/encrypted_upload_v2_vectors.rs`
- Modify: `app-sdk/tools/xtask/Cargo.toml`
- Modify: `app-sdk/Cargo.lock`
- Modify: `app-sdk/tools/xtask/src/lib.rs`
- Modify: `app-sdk/core/device-sdk-core/src/generated/mod.rs`
- Modify: `app-sdk/package.json`
- Modify: `app-sdk/scripts/check-licenses.mjs`
- Modify: `app-sdk/docs/superpowers/plans/2026-09-03-encrypted-upload-v2-protocol-contract.md`

**Interfaces:**
- Consumes: Task 2 codecs and fixed non-production keys/seeds defined only in
  the generator test module.
- Produces non-shipping Rust reference functions `parse_storage_object`,
  `parse_upload_authorization`, `parse_upload_manifest`, and
  `parse_completion_receipt`; these are used by vector tests and are not
  exported from `bota-device-sdk-core`.
- Produces CLI:
  `cargo xtask encrypted-upload-v2 vectors generate [--check]`.
- Produces canonical JSON with top-level `schemaVersion`, `contractRevision`,
  `generatedBy`, `keys`, and `cases`, plus generated constant
  `ENCRYPTED_UPLOAD_V2_VECTOR_SHA256`.

- [x] **Step 1: Add the exact development-only crypto dependencies**

Add to `tools/xtask/Cargo.toml`:

```toml
chacha20poly1305 = "0.11.0"
hmac = "0.13.0"
hpke = { version = "0.14.0", default-features = false, features = ["alloc", "chacha", "x25519"] }
p256 = { version = "0.14.0", default-features = false, features = ["ecdsa", "sha256"] }
rand_chacha = "0.10.0"
```

These dependencies remain in `xtask`; do not add them to the shipping core.
Update the MIT/Apache-2.0/BSD-3-Clause license allowlist only for the resolved
transitive crates reported by the lockfile, and keep `npm run check:licenses`
green.

- [x] **Step 2: Write vector determinism and coverage tests first**

Create `tools/xtask/tests/encrypted_upload_v2_vectors.rs`:

```rust
#[test]
fn encrypted_upload_v2_vectors_are_deterministic_and_current() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let first = xtask::encrypted_upload_v2::generated_bundle(&root).unwrap();
    let second = xtask::encrypted_upload_v2::generated_bundle(&root).unwrap();
    assert_eq!(first, second);
    assert_eq!(first, fs::read(root.join(
        "protocol/vectors/encrypted-upload-v2.json"
    )).unwrap());
}

#[test]
fn bundle_covers_every_required_category() {
    let bundle = bundle_json();
    let names: BTreeSet<_> = bundle["cases"].as_array().unwrap().iter()
        .map(|case| case["name"].as_str().unwrap())
        .collect();
    for required in [
        "storage-partial-block", "storage-multi-block",
        "authorization-development", "authorization-gamma", "authorization-production",
        "key-export-hpke", "manifest-hpke", "completion-receipt",
        "ble-fresh-transfer", "ble-window-repair", "ble-resume-accepted",
        "ble-resume-prefix-rejected", "old-sdk-new-firmware-v1",
        "new-sdk-old-firmware-v1", "historical-p10-unchanged",
    ] {
        assert!(names.contains(required), "missing vector {required}");
    }
}
```

- [x] **Step 3: Run the vector test and verify RED**

Run:

```bash
cargo test -p xtask --test encrypted_upload_v2_vectors
node --test tools/baseline/encrypted-upload-v2-vector-contract.test.mjs
```

Expected: FAIL because the generator and bundle do not exist.

- [x] **Step 4: Define and validate the vector JSON schema**

Use this exact per-case TypeScript-equivalent shape; operation-specific
`context` and `expected` objects are closed JSON Schema branches selected by
`operation`:

```ts
interface EncryptedUploadV2VectorCase {
  name: string;
  category: 'storage' | 'signed-document' | 'ble' | 'compatibility';
  operation:
    | 'verifyStorageObject'
    | 'verifyUploadAuthorization'
    | 'verifyUploadManifest'
    | 'verifyCompletionReceipt'
    | 'decodeCapabilities'
    | 'decodeSignedBlob'
    | 'decodeTransfer'
    | 'runCompatibilityTrace';
  inputHex: string;
  context: Record<string, string | number | boolean>;
  expected?: Record<string, string | number | boolean | string[] | number[]>;
  expectedError?: string;
}
```

The checked-in JSON contains only concrete hex generated from the fixed inputs
in Step 5. The schema requires lowercase even-length hex, canonical UUID text,
safe JSON integers, and exactly one of `expected` or `expectedError`.
The Node test compiles this schema with the workspace's pinned AJV 8.20.0,
validates the generated bundle, and rejects one fixture with an uppercase or
odd-length hex field.

- [x] **Step 5: Implement deterministic vector construction**

Use fixed seeds and keys, never OS randomness:

```rust
const VECTOR_RNG_SEED: [u8; 32] = [0x42; 32];
const DEVICE_ROOT_KEY: [u8; 32] = [0x11; 32];
const DATA_KEY: [u8; 32] = [0x22; 32];
const BACKEND_P256_SIGNING_KEY: [u8; 32] = [0x33; 32];
const HPKE_RECIPIENT_PRIVATE_KEY: [u8; 32] = [0x44; 32];
const RECORDING_UUID: [u8; 16] = [
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
    0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
];
```

Implement the spec's domain-separated HKDF, storage header wrap, per-block
ChaCha20-Poly1305 AEAD, trailer HMAC, authorization P1363 low-S signature,
RFC 9180 HPKE seal/open, manifest HMAC, and receipt signature. Use
`ChaCha20Rng::from_seed(VECTOR_RNG_SEED)` only for deterministic HPKE
encapsulation. Assert the signature is normalized to low-S before serializing.

In the same non-shipping xtask module, add exact-length reference parsers for
the 128-byte header, variable block frames, 144-byte trailer, 408-byte
authorization, 580-byte manifest, and 336-byte receipt. Those parsers enforce
magic, version, suite, reserved, block-length, total-length, and checked-offset
rules before cryptographic verification. They return normalized structs used
only to construct `expected.normalized` values.

- [x] **Step 6: Emit the complete positive, malformed, and trace matrix**

Generate concrete cases for:

```text
Storage: partial block, multiple blocks, wrong magic/version/header length,
reserved byte, zero/oversize plaintext block, altered block tag, altered
trailer tag, altered plaintext hash, altered ciphertext hash, trailing byte.

Signed documents and key export: three authorization environments, the exact
96-byte `K_data || storage_identity_digest || upload_context_digest` HPKE
plaintext, high-S signature,
altered signature, expired authorization, wrong environment/tenant/device/
binding/recording/staging/ciphertext digest, wrong recipient key, altered
manifest HPKE payload, altered manifest tag, altered receipt signature,
expired receipt, idempotent identical receipt, conflicting replay receipt.

BLE: capability, all five signed-blob frames, LIST, RECORDING_ENTRY, LIST_END,
START, START_ACK, DATA, WINDOW_END, clean WINDOW_ACK, repair WINDOW_ACK,
MANIFEST_CHUNK, EOF, RESUME_REQUEST, RESUME_ACCEPT, RESUME_REJECT, CONFIRM,
ABORT, ERROR, STATUS, every-byte truncation representatives, trailing byte,
nonzero reserved byte, unknown flag/message/version, count/length mismatch,
duplicate/out-of-order blob chunk, zero/wrong session, identity/generation/
prefix mismatch, mixed v1/P10/v2 bytes.

Compatibility traces: old SDK + old firmware v1, new SDK + old firmware v1,
old SDK + new firmware legacy START returning v1, new SDK + new firmware v2
only after capability read, historical P10 relay unchanged, and
v2_required rejection for batch plus legacy streaming.
```

- [x] **Step 7: Wire the CLI, generated digest, and package scripts**

Add these scripts:

```json
{
  "encrypted-upload-v2:vectors": "cargo xtask encrypted-upload-v2 vectors generate",
  "encrypted-upload-v2:vectors:check": "cargo xtask encrypted-upload-v2 vectors generate --check"
}
```

The check command compares both JSON bytes and the generated Rust digest file.
It exits nonzero on drift.

- [x] **Step 8: Generate, validate, and commit the canonical bundle**

Run:

```bash
cargo xtask encrypted-upload-v2 vectors generate
cargo xtask encrypted-upload-v2 vectors generate --check
cargo test -p xtask --test encrypted_upload_v2_vectors
node --test tools/baseline/encrypted-upload-v2-vector-contract.test.mjs
cargo test -p bota-device-sdk-core --test encrypted_upload_v2_codec
npm run check:licenses
cargo fmt --all -- --check
cargo clippy -p xtask --all-targets -- -D warnings
```

Mark Task 3 checked in the plan, then commit:

```bash
git add tools/xtask/Cargo.toml Cargo.lock \
  tools/xtask/src/encrypted_upload_v2.rs \
  tools/xtask/src/lib.rs \
  tools/xtask/tests/encrypted_upload_v2_vectors.rs \
  tools/baseline/encrypted-upload-v2-vector-contract.test.mjs \
  protocol/vectors/encrypted-upload-v2.schema.json \
  protocol/vectors/encrypted-upload-v2.json \
  core/device-sdk-core/src/generated/encrypted_upload_v2_vectors.rs \
  core/device-sdk-core/src/generated/mod.rs \
  package.json scripts/check-licenses.mjs \
  docs/superpowers/plans/2026-09-03-encrypted-upload-v2-protocol-contract.md
git diff --cached --check
git commit -m "test: add encrypted upload v2 golden vectors" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

Record the canonical source revision for downstream tasks with:

```bash
git log -1 --format=%H -- protocol/vectors/encrypted-upload-v2.json
```

---

### Task 4: Expose Additive Native Contract Inspection Through the Rust ABI

**Files:**
- Modify: `app-sdk/bindings/device-sdk-ffi/src/packet.rs`
- Modify: `app-sdk/bindings/device-sdk-ffi/src/protocol.rs`
- Modify: `app-sdk/bindings/device-sdk-ffi/include/bota_device_sdk.h`
- Create: `app-sdk/bindings/device-sdk-ffi/bota_device_sdk.h.sha256`
- Modify: `app-sdk/bindings/device-sdk-ffi/tests/packet_contract.rs`
- Modify: `app-sdk/platforms/apple/Sources/BotaAppleSDK/Core/CoreModelMapper.swift`
- Create: `app-sdk/platforms/apple/Sources/BotaAppleSDK/Models/EncryptedUploadV2ContractModels.swift`
- Modify: `app-sdk/platforms/apple/Tests/BotaAppleSDKTests/ProtocolCodecTests.swift`
- Modify: `app-sdk/platforms/apple/Package.swift`
- Create: `app-sdk/platforms/apple/Tests/BotaAppleSDKTests/Resources/EncryptedUploadV2Vectors/encrypted-upload-v2.json`
- Create: `app-sdk/platforms/apple/Tests/BotaAppleSDKTests/Resources/EncryptedUploadV2Vectors/encrypted-upload-v2.sha256`
- Create: `app-sdk/platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/core/Protocol.kt`
- Modify: `app-sdk/platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/core/CoreModelMapper.kt`
- Create: `app-sdk/platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/core/EncryptedUploadV2ContractModels.kt`
- Modify: `app-sdk/platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/internal/core/ProtocolCodecTest.kt`
- Create: `app-sdk/platforms/android/sdk/src/androidTest/assets/EncryptedUploadV2Vectors/encrypted-upload-v2.json`
- Create: `app-sdk/platforms/android/sdk/src/androidTest/assets/EncryptedUploadV2Vectors/encrypted-upload-v2.sha256`
- Create: `app-sdk/tools/apple/sync-encrypted-upload-v2-vectors.mjs`
- Create: `app-sdk/tools/android/sync-encrypted-upload-v2-vectors.mjs`
- Modify: `app-sdk/tools/apple/build-xcframework.sh`
- Modify: `app-sdk/tools/android/build-native.sh`
- Modify: `app-sdk/package.json`
- Modify: `app-sdk/docs/superpowers/plans/2026-09-03-encrypted-upload-v2-protocol-contract.md`

**Interfaces:**
- Consumes: Task 2 Rust codecs and Task 3 vector bundle.
- Produces additive ABI packet kinds `0x0520..0x0522` for capability,
  signed-blob, and transfer/status framing inspection. Existing
  `0x0501..0x051F` values do not move; storage objects and signed-document
  internals are never exposed through the native SDK ABI.
- Produces a current ABI-header digest lock for Apple artifact builds. The
  historical `1.0.0-alpha.1` evidence remains immutable when the additive ABI
  grows.
- Produces internal Swift/Kotlin `EncryptedUploadV2ContractValue`; it is not a
  public SDK model and does not start a transfer.

- [x] **Step 1: Freeze additive ABI numbers and fields in tests**

Add header/ABI assertions for these exact packet kinds:

```text
0x0520 DECODE_ENCRYPTED_UPLOAD_V2_CAPABILITY
0x0521 DECODE_ENCRYPTED_UPLOAD_V2_SIGNED_BLOB
0x0522 DECODE_ENCRYPTED_UPLOAD_V2_TRANSFER_OR_STATUS
```

Append field IDs `127..164` in this exact order. The originally proposed
`112..149` range collided with the already-shipped `CAPACITY` through
`UPLOADED_CHUNKS` fields at `112..126`; those existing ABI values remain
unchanged:

```text
MESSAGE_TYPE, TRANSPORT_SESSION_ID, RECORDING_GENERATION, CIPHERTEXT_LENGTH,
PLAINTEXT_LENGTH, UPLOAD_SESSION_UUID, CHECKPOINT_REVISION, WINDOW_PACKETS,
DATA_PAYLOAD_BYTES, MISSING_SEQUENCE, CAPABILITY_FLAGS,
MAX_SIGNED_BLOB_BYTES, MAX_MANIFEST_BYTES, CHECKPOINT_INTERVAL,
MAX_MISSING_SEQUENCES, MANIFEST_SHA256, PREFIX_SHA256, CIPHERTEXT_SHA256,
BLOCK_COUNT, COMPLETION_STATE, STORAGE_FORMAT, LIST_REVISION, DURATION_SECONDS,
BODY_LENGTH, BLOB_KIND, WRITE_ID, PHASE, TRANSPORT_PROFILE, DETAIL_CODE,
PROFILE_VERSION, REQUEST_FLAGS, FIRST_SEQUENCE, LAST_SEQUENCE, WINDOW_INDEX,
AUTHORIZATION_SHA256, RECEIPT_SHA256, PROGRESS_PERCENT,
DURABLE_CIPHERTEXT_BYTES.
```

- [x] **Step 2: Run the ABI tests and verify RED**

Run:

```bash
cargo test -p bota-device-sdk-ffi abi_contract
```

Expected: FAIL because the additive kinds and fields do not exist.

- [x] **Step 3: Map Rust normalized values into ABI packets**

Keep one decode input (`FIELD_VALUE`) and emit only scalar/UUID/digest framing
metadata. DATA, manifest chunks, signed-blob chunks, authorizations, manifests,
receipts, and complete storage objects remain opaque and are returned only as
the already-borrowed `FIELD_VALUE` when the caller explicitly requests that
framing variant.

Use this dispatch pattern:

```rust
packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_CAPABILITY => {
    let value = decode_encrypted_upload_v2_capabilities(&value)?;
    Ok(output
        .with_u64(field_id::CAPABILITY_FLAGS, u64::from(value.flags))
        .with_u64(field_id::MAX_SIGNED_BLOB_BYTES, u64::from(value.maximum_signed_blob_bytes))
        .with_u64(field_id::MAX_MANIFEST_BYTES, u64::from(value.maximum_manifest_bytes))
        .with_u64(field_id::DATA_PAYLOAD_BYTES, u64::from(value.maximum_data_payload_bytes))
        .with_u64(field_id::WINDOW_PACKETS, u64::from(value.maximum_window_packets))
        .with_u64(field_id::CHECKPOINT_INTERVAL, u64::from(value.durable_checkpoint_interval_blocks))
        .with_u64(field_id::MAX_MISSING_SEQUENCES, u64::from(value.maximum_missing_sequences)))
}
```

Add equivalent exhaustive branches for signed-blob and transfer/status framing
and reject unexpected input fields with the existing
`PacketFields::validate_allowed`.

- [x] **Step 4: Add internal Swift and Kotlin mappings**

Use one normalized internal shape on both platforms:

```swift
struct EncryptedUploadV2ContractValue: Equatable {
    let kind: UInt8
    let messageType: UInt8?
    let flags: UInt32?
    let transportSessionID: UInt64?
    let recordingUUID: String?
    let recordingGeneration: UInt32?
    let sequence: UInt32?
    let offset: UInt64?
    let length: UInt64?
    let result: UInt16?
    let authorizationSHA256: Data?
    let ciphertextSHA256: Data?
    let prefixSHA256: Data?
    let manifestSHA256: Data?
    let receiptSHA256: Data?
}
```

```kotlin
internal data class EncryptedUploadV2ContractValue(
    val kind: UByte,
    val messageType: UByte? = null,
    val flags: UInt? = null,
    val transportSessionId: ULong? = null,
    val recordingUuid: String? = null,
    val recordingGeneration: UInt? = null,
    val sequence: UInt? = null,
    val offset: ULong? = null,
    val length: ULong? = null,
    val result: UShort? = null,
    val authorizationSha256: ByteArray? = null,
    val ciphertextSha256: ByteArray? = null,
    val prefixSha256: ByteArray? = null,
    val manifestSha256: ByteArray? = null,
    val receiptSha256: ByteArray? = null,
)
```

Implement platform mapper methods that choose the ABI kind by vector
`operation` and return the normalized shape. Keep these types internal.

- [x] **Step 5: Add exact vector synchronization scripts**

Each script reads `protocol/vectors/encrypted-upload-v2.json`, computes SHA-256,
and writes the exact JSON bytes plus a lowercase digest and newline to
`encrypted-upload-v2.sha256` in its platform resource directory. `--check`
compares filenames, content, and the generated Rust digest constant; it never
normalizes JSON.

Add package scripts:

```json
{
  "sync:apple-encrypted-upload-v2-vectors": "node tools/apple/sync-encrypted-upload-v2-vectors.mjs --check",
  "sync:android-encrypted-upload-v2-vectors": "node tools/android/sync-encrypted-upload-v2-vectors.mjs --check"
}
```

- [x] **Step 6: Run native conformance over every structural vector**

Swift and Kotlin tests load the new resource separately from the frozen v1
fixture list. For each structural operation, compare the mapper's normalized
output with `expected.normalized`; for each malformed structural operation,
assert the stable SDK error code. Crypto-owner-only cases are asserted as
opaque byte-preserving inputs, not reimplemented in the facade.

Run:

```bash
node tools/apple/sync-encrypted-upload-v2-vectors.mjs
node tools/android/sync-encrypted-upload-v2-vectors.mjs
npm run sync:apple-encrypted-upload-v2-vectors
npm run sync:android-encrypted-upload-v2-vectors
cargo test -p bota-device-sdk-ffi
swift test --package-path platforms/apple
ANDROID_HOME="$HOME/Library/Android/sdk" platforms/android/gradlew \
  -p platforms/android testDebugUnitTest connectedDebugAndroidTest
```

Expected: all available host tests PASS. If no Android emulator is available,
`testDebugUnitTest` must pass and `connectedDebugAndroidTest` is reported as a
hardware/emulator gate rather than silently omitted.

- [x] **Step 7: Commit the additive native contract slice**

Mark Task 4 checked in the plan and commit only listed paths:

```bash
git add bindings/device-sdk-ffi \
  platforms/apple/Sources/BotaAppleSDK/Core/CoreModelMapper.swift \
  platforms/apple/Sources/BotaAppleSDK/Models/EncryptedUploadV2ContractModels.swift \
  platforms/apple/Package.swift \
  platforms/apple/Tests/BotaAppleSDKTests/ProtocolCodecTests.swift \
  platforms/apple/Tests/BotaAppleSDKTests/Resources/EncryptedUploadV2Vectors \
  platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/core/Protocol.kt \
  platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/core/CoreModelMapper.kt \
  platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/core/EncryptedUploadV2ContractModels.kt \
  platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/internal/core/ProtocolCodecTest.kt \
  platforms/android/sdk/src/androidTest/assets/EncryptedUploadV2Vectors \
  tools/apple/sync-encrypted-upload-v2-vectors.mjs \
  tools/apple/build-xcframework.sh \
  tools/android/build-native.sh \
  tools/android/sync-encrypted-upload-v2-vectors.mjs package.json \
  docs/superpowers/plans/2026-08-30-native-abi-foundation.md \
  docs/superpowers/plans/2026-09-03-encrypted-upload-v2-protocol-contract.md
git diff --cached --check
git commit -m "feat: expose encrypted upload v2 contract inspection" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

---

### Task 5: Gate the App SDK React Native Boundary and Runtime Claims

**Files:**
- Create: `app-sdk/frameworks/react-native/test/encrypted-upload-v2-contract.test.mjs`
- Modify: `app-sdk/frameworks/react-native/test/bridge-contract.test.mjs`
- Modify: `app-sdk/protocol/compatibility/firmware-compatibility.json`
- Modify: `app-sdk/ARCHITECTURE.md` using only task-owned hunks
- Modify: `app-sdk/AGENTS.md` using only task-owned hunks
- Modify: `app-sdk/docs/superpowers/specs/2026-09-03-encrypted-upload-v2-protocol-contract-design.md`
- Modify: `app-sdk/docs/superpowers/plans/2026-09-03-encrypted-upload-v2-protocol-contract.md`

**Interfaces:**
- Consumes: canonical bundle/digest and native contract inspection from Tasks
  3-4.
- Produces: test evidence that App SDK React Native carries only low-volume
  identifiers/status and exposes no v2 runtime workflow.
- Produces: compatibility metadata status `contract_only`, runtime support
  `false`, firmware capability advertised `false`.

- [x] **Step 1: Write boundary tests first**

Add this contract test:

```js
test('encrypted upload v2 is contract-only and absent from Codegen bytes', () => {
  const spec = readFileSync('src/specs/NativeBotaDeviceSDK.ts', 'utf8');
  for (const forbidden of [
    'ciphertext: Array', 'manifest: Array', 'authorization: Array',
    'receipt: Array', 'ciphertextBase64', 'manifestBase64',
    'authorizationBase64', 'receiptBase64',
  ]) {
    assert.equal(spec.includes(forbidden), false, forbidden);
  }
  assert.equal(spec.includes('startEncryptedUploadV2'), false);
});
```

Also assert the vector file SHA-256 equals the generated Rust digest constant
and that no runtime manager source contains any v2 START opcode or v2
characteristic UUID.

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
cd frameworks/react-native
node --test test/encrypted-upload-v2-contract.test.mjs test/bridge-contract.test.mjs
```

Expected: FAIL until vector/digest discovery and compatibility metadata are
wired.

- [x] **Step 3: Mark contract presence without claiming runtime support**

Add an `encryptedUploadV2` compatibility entry with this exact meaning:

```json
{
  "contractRevision": "encrypted-upload-v2-contract-v1",
  "contractVectors": true,
  "rustCodec": true,
  "appleFacadeInspection": true,
  "androidFacadeInspection": true,
  "reactNativeBridgeBytes": false,
  "runtimeWorkflow": false,
  "firmwareAdvertised": false,
  "status": "contract_only"
}
```

Update architecture/agent docs to say contract inspection exists but selection,
transfer, staging, and deletion remain unimplemented. Do not edit or discard
pre-existing unrelated hunks; stage with `git add -p`.

- [x] **Step 4: Run App SDK regression gates**

Run:

```bash
cd /Users/zhangqi/ws/bota/app-sdk
npm run test:react-native
npm run react-native:verify
npm run baseline:react-native -- \
  --sdk-path ../.worktrees/react-native-sdk-baseline \
  --expected-commit 44ac1221cb71eb01cafcdbfdf7a370847d3a10b4
npm run test:fixtures
npm run sync:apple-fixtures
npm run sync:android-fixtures
cargo xtask protocol generate --check
cargo xtask encrypted-upload-v2 vectors generate --check
cargo test --workspace
```

Expected: existing v1/P10 fixture counts and digest remain unchanged; all new
contract gates PASS.

- [x] **Step 5: Commit only task-owned hunks**

Mark Task 5 checked in the plan, then use interactive staging for already-dirty
docs:

```bash
git add frameworks/react-native/test/encrypted-upload-v2-contract.test.mjs \
  frameworks/react-native/test/bridge-contract.test.mjs \
  protocol/compatibility/firmware-compatibility.json \
  docs/superpowers/specs/2026-09-03-encrypted-upload-v2-protocol-contract-design.md \
  docs/superpowers/plans/2026-09-03-encrypted-upload-v2-protocol-contract.md
git add -p AGENTS.md ARCHITECTURE.md
git diff --cached --check
git commit -m "test: gate encrypted upload v2 contract support" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

---

### Task 6: Vendor the Contract and Add Internal Codecs to `react-native-sdk`

**Files:**
- Create: `react-native-sdk/protocol/vendor/app-sdk/encrypted-upload-v2.json`
- Create: `react-native-sdk/protocol/vendor/app-sdk/encrypted-upload-v2.source.json`
- Create: `react-native-sdk/scripts/sync-encrypted-upload-v2-vectors.mjs`
- Create: `react-native-sdk/scripts/sync-encrypted-upload-v2-vectors.test.mjs`
- Create: `react-native-sdk/src/protocol/encryptedUploadV2.ts`
- Create: `react-native-sdk/__tests__/encryptedUploadV2.test.ts`
- Modify: `react-native-sdk/package.json`
- Modify: `react-native-sdk/src/ble/constants.ts`
- Modify: `react-native-sdk/AGENTS.md`
- Modify: `react-native-sdk/ARCHITECTURE.md`
- Modify: `react-native-sdk/FIRMWARE_PROTOCOL.md`

**Interfaces:**
- Consumes: committed App SDK vector revision selected by
  `git -C ../app-sdk log -1 --format=%H -- protocol/vectors/encrypted-upload-v2.json`.
- Produces internal `decodeEncryptedUploadV2Capabilities`,
  `supportsEncryptedUploadV2Batch`, `decodeEncryptedUploadV2Document`,
  `decodeEncryptedUploadV2SignedBlob`, `encodeEncryptedUploadV2SignedBlob`,
  `decodeEncryptedUploadV2Transfer`, and `encodeEncryptedUploadV2Transfer`.
- Produces no root export and no `RecordingManager`, `StreamingSession`,
  `ProtocolHandler`, or `BleManager` call site.

- [ ] **Step 1: Write vector-sync tests first**

The test creates a temporary git repository containing a canonical vector,
commits it, invokes the sync function, and asserts this sidecar schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["sourceRepository", "sourcePath", "sourceRevision", "sha256"],
  "properties": {
    "sourceRepository": { "const": "bota-dev/app-sdk" },
    "sourcePath": { "const": "protocol/vectors/encrypted-upload-v2.json" },
    "sourceRevision": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
    "sha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
  }
}
```

It also mutates one vendored byte and proves `--check` exits nonzero.

- [ ] **Step 2: Run sync tests and verify RED**

Run:

```bash
cd /Users/zhangqi/ws/bota/react-native-sdk
node --test scripts/sync-encrypted-upload-v2-vectors.test.mjs
```

Expected: FAIL because the sync script does not exist.

- [ ] **Step 3: Implement revision-pinned vendoring**

The script accepts named `--app-sdk` and `--source-revision` values plus an
optional `--check` flag. Write mode requires both named values. `--check`
without them validates the vendored bytes against the recorded sidecar so CI
does not require a sibling checkout; when both are supplied, check mode also
compares with `git show`. `--app-sdk` resolves to a git checkout and
`--source-revision` must match `^[0-9a-f]{40}$`.

It validates the revision with `/^[0-9a-f]{40}$/`, reads only
`git show ${sourceRevision}:protocol/vectors/encrypted-upload-v2.json`, validates the
JSON contract revision, computes SHA-256, and writes or checks the two vendor
files. It never reads the App SDK working-tree vector.

Add package scripts:

```json
{
  "sync:encrypted-upload-v2": "node scripts/sync-encrypted-upload-v2-vectors.mjs",
  "sync:encrypted-upload-v2:check": "node scripts/sync-encrypted-upload-v2-vectors.mjs --check"
}
```

- [ ] **Step 4: Vendor the committed canonical vector**

Run:

```bash
V2_SOURCE_REVISION="$(git -C ../app-sdk log -1 --format=%H -- protocol/vectors/encrypted-upload-v2.json)"
node scripts/sync-encrypted-upload-v2-vectors.mjs \
  --app-sdk ../app-sdk --source-revision "$V2_SOURCE_REVISION"
node scripts/sync-encrypted-upload-v2-vectors.mjs \
  --app-sdk ../app-sdk --source-revision "$V2_SOURCE_REVISION" --check
```

Expected: the vendored JSON bytes exactly match `git show` at the recorded
revision.

- [ ] **Step 5: Write codec and capability tests before source**

Drive every applicable structural vector through an operation table:

```ts
const operations = {
  decodeCapabilities: decodeEncryptedUploadV2Capabilities,
  decodeDocument: ({ kind, bytes }: VectorInput) =>
    decodeEncryptedUploadV2Document(kind, bytes),
  decodeSignedBlob: ({ bytes }: VectorInput) =>
    decodeEncryptedUploadV2SignedBlob(bytes),
  decodeTransfer: ({ bytes }: VectorInput) =>
    decodeEncryptedUploadV2Transfer(bytes),
};

it('requires explicit batch capabilities 0 through 6', () => {
  expect(supportsEncryptedUploadV2Batch(capabilityWithFlags(0x7f))).toBe(true);
  expect(supportsEncryptedUploadV2Batch(capabilityWithFlags(0x7e))).toBe(false);
  expect(supportsEncryptedUploadV2Batch(undefined)).toBe(false);
});
```

Assert encode cases reproduce exact hex, malformed cases throw the vector's
stable error name, and legacy v1/P10 parser tests remain byte-identical.

- [ ] **Step 6: Run the codec tests and verify RED**

Run:

```bash
npx jest __tests__/encryptedUploadV2.test.ts --runInBand
```

Expected: FAIL because the internal codec module does not exist.

- [ ] **Step 7: Implement internal TypeScript codecs**

Use `Buffer.readUInt*LE` / `writeUInt*LE`, a checked cursor, exact-length
guards, fixed-size digest copies, and exhaustive discriminated unions. Define:

```ts
export type EncryptedUploadV2Availability = 'unsupported' | 'batch';

export function supportsEncryptedUploadV2Batch(
  value: EncryptedUploadV2Capabilities | undefined,
): boolean {
  const required = 0x7f;
  return value !== undefined
    && value.highestTransferProfileVersion === 2
    && (value.flags & required) === required;
}
```

Do not treat bit 7 as required and do not return a streaming capability. Keep
document payloads, DATA bytes, manifests, authorizations, and receipts opaque;
the decoder reports their structural metadata without decrypting them.

- [ ] **Step 8: Freeze UUID constants without wiring runtime managers**

Add internal constants for full UUIDs `B07A0004-0006` through `000B`. Add a
test that `rg`-equivalent source inspection finds these UUIDs only in constants,
the internal codec test, and protocol docs—not in manager or BLE runtime files.

- [ ] **Step 9: Update repository docs accurately**

Document three profiles, the pinned vector ownership, and these status facts:

```text
Contract parser/serializer: present, internal
Runtime capability negotiation: not wired
Batch-v2 transfer: not wired
Streaming-v2: undefined
Legacy v1/P10: unchanged
BACKEND_PUBKEY selection: prohibited
```

- [ ] **Step 10: Verify public compatibility and commit**

Run:

```bash
npm test -- --runInBand
npm run typecheck
npm run lint
npm run build
npm run license-check
git diff -- lib/typescript/src/index.d.ts
```

Expected: all commands PASS and the root public declaration surface has no new
export.

Commit:

```bash
git add protocol/vendor/app-sdk scripts/sync-encrypted-upload-v2-vectors.mjs \
  scripts/sync-encrypted-upload-v2-vectors.test.mjs \
  src/protocol/encryptedUploadV2.ts __tests__/encryptedUploadV2.test.ts \
  src/ble/constants.ts package.json AGENTS.md ARCHITECTURE.md FIRMWARE_PROTOCOL.md
git diff --cached --check
git commit -m "feat: add internal encrypted upload v2 contract codecs" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

---

### Task 7: Add the Backend Reference Parser and Crypto Verifier

**Files:**
- Create: `bota/api/tests/fixtures/encrypted-upload-v2/encrypted-upload-v2.json`
- Create: `bota/api/tests/fixtures/encrypted-upload-v2/source.json`
- Create: `bota/api/scripts/sync-encrypted-upload-v2-vectors.mjs`
- Create: `bota/api/scripts/sync-encrypted-upload-v2-vectors.test.mjs`
- Create: `bota/api/src/utils/encrypted-upload-v2-contract.ts`
- Create: `bota/api/tests/unit/encrypted-upload-v2-contract.test.ts`
- Modify: `bota/api/package.json`
- Modify: `bota/api/CLAUDE.md`
- Modify: `bota/AGENTS.md`
- Modify: `bota/ARCHITECTURE.md`

**Interfaces:**
- Consumes: committed
  `app-sdk/protocol/vectors/encrypted-upload-v2.json`; its sidecar records
  repository `bota-dev/app-sdk`, source path
  `protocol/vectors/encrypted-upload-v2.json`, a 40-hex source revision, and a
  64-hex SHA-256.
- Produces pure functions `parseUploadAuthorizationV2`,
  `verifyUploadAuthorizationV2`, `parseUploadManifestV2`,
  `verifyUploadManifestV2`, `parseCompletionReceiptV2`,
  `verifyCompletionReceiptV2`, and `verifyBotaEncV2Object`.
- Produces no router export, service singleton, queue registration, migration,
  signing-key lookup, S3 read, or worker dispatch.

- [ ] **Step 1: Write the revision-pinned sync test**

Create a temporary git repository, write and commit
`protocol/vectors/encrypted-upload-v2.json`, invoke the sync function with its
40-hex commit, and assert the backend fixture bytes equal `git show`. Assert
`source.json` has exactly `sourceRepository`, `sourcePath`, `sourceRevision`,
and `sha256`; validate the two hex patterns; mutate one vendored byte; then
assert `--check` exits nonzero without a sibling App SDK checkout.

- [ ] **Step 2: Run the sync test and verify RED**

Run:

```bash
cd /Users/zhangqi/ws/bota/bota/api
node --test scripts/sync-encrypted-upload-v2-vectors.test.mjs
```

Expected: FAIL because the script does not exist.

- [ ] **Step 3: Implement and run revision-pinned vendoring**

Add scripts:

```json
{
  "sync:encrypted-upload-v2": "node scripts/sync-encrypted-upload-v2-vectors.mjs",
  "sync:encrypted-upload-v2:check": "node scripts/sync-encrypted-upload-v2-vectors.mjs --check"
}
```

Write mode requires both `--app-sdk` and `--source-revision`. Check mode without
arguments validates the vendored bytes against the recorded sidecar for CI;
check mode with both arguments additionally compares the committed source via
`git show`.

Then run:

```bash
V2_SOURCE_REVISION="$(git -C ../../app-sdk log -1 --format=%H -- protocol/vectors/encrypted-upload-v2.json)"
node scripts/sync-encrypted-upload-v2-vectors.mjs \
  --app-sdk ../../app-sdk --source-revision "$V2_SOURCE_REVISION"
node scripts/sync-encrypted-upload-v2-vectors.mjs \
  --app-sdk ../../app-sdk --source-revision "$V2_SOURCE_REVISION" --check
```

- [ ] **Step 4: Write verifier tests first**

The tests load every backend-owned vector operation and use fixed test keys
from the bundle:

```ts
it.each(validCases)('$name', async ({ operation, inputHex, context, expected }) => {
  const actual = await operations[operation](Buffer.from(inputHex, 'hex'), context);
  expect(normalize(actual)).toEqual(expected.normalized);
});

it.each(invalidCases)('$name', async ({ operation, inputHex, context, expectedError }) => {
  await expect(operations[operation](Buffer.from(inputHex, 'hex'), context))
    .rejects.toThrow(expectedError);
});
```

Explicitly assert high-S authorization/receipt rejection, altered tag/hash,
wrong environment/identity/generation/recipient key, expired material, wrong
HPKE context, and identical-versus-conflicting receipt replay inputs.

- [ ] **Step 5: Run the verifier test and verify RED**

Run:

```bash
npx vitest run tests/unit/encrypted-upload-v2-contract.test.ts
```

Expected: FAIL because the parser/verifier does not exist.

- [ ] **Step 6: Implement strict parsing and crypto verification**

Use Node `crypto` for SHA-256, HMAC, `timingSafeEqual`, and P-256 verification
with `dsaEncoding: 'ieee-p1363'`; reject `s > n/2` before verification. Use the
already-installed `hpke-js` for RFC 9180 base mode with KEM `0x0020`, KDF
`0x0001`, and AEAD `0x0003`.

Keep the dependency-injected verification boundary explicit:

```ts
export interface EncryptedUploadV2VerificationContext {
  nowSeconds: bigint;
  environment: 0 | 1 | 2;
  backendP256PublicKey: KeyObject;
  hpkeRecipientPrivateKey?: Uint8Array;
  dataKey?: Uint8Array;
  expectedTenantContextDigest?: Buffer;
  expectedDeviceIdentityDigest?: Buffer;
}
```

Never load production keys or configuration inside this module. Return parsed
metadata only after all applicable structural and cryptographic checks pass.

- [ ] **Step 7: Re-run downgrade regression tests**

Run:

```bash
npx vitest run \
  tests/unit/encrypted-upload-v2-contract.test.ts \
  tests/unit/encrypted-upload-policy.test.ts \
  tests/unit/encrypted-upload-legacy-recording-boundaries.test.ts
```

Expected: v2-required rejects whole-file completion, chunk URL issuance, and
streaming finalization; permitted v1/P10 behavior remains unchanged.

- [ ] **Step 8: Document test-only status and commit**

Update backend docs to say the reference verifier is reusable but unregistered;
the public v2 API, signed authorization producer, worker, and receipt producer
remain unimplemented. Do not stage `infra/CLAUDE.md`.

Run:

```bash
npm run type-check
npm run lint
npm test -- --run
git add api/tests/fixtures/encrypted-upload-v2 \
  api/scripts/sync-encrypted-upload-v2-vectors.mjs \
  api/scripts/sync-encrypted-upload-v2-vectors.test.mjs \
  api/src/utils/encrypted-upload-v2-contract.ts \
  api/tests/unit/encrypted-upload-v2-contract.test.ts \
  api/package.json api/CLAUDE.md AGENTS.md ARCHITECTURE.md
git diff --cached --check
git commit -m "test: add encrypted upload v2 contract verifier" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

---

### Task 8: Add a Host-Only Firmware Reference Decoder

**Files:**
- Create: `firmware/scripts/fixtures/encrypted-upload-v2/encrypted-upload-v2.json`
- Create: `firmware/scripts/fixtures/encrypted-upload-v2/source.json`
- Create: `firmware/scripts/sync_encrypted_upload_v2_vectors.py`
- Create: `firmware/scripts/encrypted_upload_v2_reference.py`
- Create: `firmware/scripts/test_encrypted_upload_v2_contract.py`
- Create: `firmware/scripts/requirements-encrypted-upload-v2.txt`
- Modify: `firmware/scripts/test_ble_e2e_disabled_config.py`
- Modify: `firmware/AGENTS.md`
- Modify: `firmware/CLAUDE.md`
- Modify: `firmware/ARCHITECTURE.md`

**Interfaces:**
- Consumes: committed
  `app-sdk/protocol/vectors/encrypted-upload-v2.json`; the local `source.json`
  records repository `bota-dev/app-sdk`, canonical source path, 40-hex source
  revision, and 64-hex SHA-256.
- Produces host-only Python structural/crypto conformance. No file under
  `sdk/` changes and no code is linked into `sdk.elf`.
- Produces a regression assertion that current legacy START keeps
  `g_transfer.e2e_enabled = 0` and contains no v2 UUID/opcode/capability.

- [ ] **Step 1: Add the host-test dependency pin**

Create:

```text
cryptography==50.0.1
```

This dependency is only for the isolated contract-test virtual environment;
production firmware and JieLi builds do not consume Python packages.

- [ ] **Step 2: Write sync and decoder tests first**

Test exact source-revision/digest checks and these normalized structural values:

```python
def test_capability_requires_batch_bits_zero_through_six(self):
    parsed = decode_capabilities(bytes.fromhex(self.case("capability")["inputHex"]))
    self.assertEqual(parsed["highestTransferProfileVersion"], 2)
    self.assertEqual(parsed["flags"] & 0x7F, 0x7F)
    self.assertFalse(parsed["flags"] & 0x80)

def test_runtime_firmware_does_not_advertise_v2(self):
    source = LE_TRANS_DATA.read_text(encoding="utf-8-sig", errors="ignore")
    lower_source = source.lower()
    for forbidden in ("B07A0004-0006", "ENCRYPTED_UPLOAD_V2_CAP_BATCH"):
        self.assertNotIn(forbidden.lower(), lower_source)
```

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
python3 scripts/test_encrypted_upload_v2_contract.py
```

Expected: FAIL because the sync/reference modules and fixtures do not exist.

- [ ] **Step 4: Implement revision-pinned vector sync**

Use `subprocess.run(["git", "-C", app_sdk, "show", f"{revision}:{source_path}"],
check=True, capture_output=True)` with argument arrays, never a shell string.
Validate 40-hex revision, contract revision, concrete SHA-256, and exact bytes.

Run:

```bash
V2_SOURCE_REVISION="$(git -C ../app-sdk log -1 --format=%H -- protocol/vectors/encrypted-upload-v2.json)"
python3 scripts/sync_encrypted_upload_v2_vectors.py \
  --app-sdk ../app-sdk --source-revision "$V2_SOURCE_REVISION"
python3 scripts/sync_encrypted_upload_v2_vectors.py \
  --app-sdk ../app-sdk --source-revision "$V2_SOURCE_REVISION" --check
```

- [ ] **Step 5: Implement the host-only decoder and crypto verifier**

Use `struct.unpack_from` with explicit `<` formats, bounds-check before every
read/allocation, `hashlib.sha256`, `hmac.compare_digest`,
`ChaCha20Poly1305`, `HKDF`, X25519, and P-256 verification from
`cryptography`. Convert raw P1363 `r || s` to DER only after enforcing
`s <= n/2`. Implement RFC 9180 labeled extract/expand exactly as fixed by the
spec and vectors; do not substitute a generic X25519+HKDF envelope.

Expose exactly six module functions: `decode_capabilities(data: bytes)`,
`decode_document(kind: str, data: bytes)`, `decode_signed_blob(data: bytes)`,
`decode_transfer(data: bytes)`,
`verify_storage_object(data: bytes, context: dict[str, object])`, and
`verify_signed_document(kind: str, data: bytes, context: dict[str, object])`.
Every function returns `dict[str, object]`; the implementation contains
complete function bodies and no `pass` statements.

- [ ] **Step 6: Run isolated host conformance and disabled-runtime gates**

Run:

```bash
V2_TEST_ENV="$(mktemp -d)"
python3 -m venv "$V2_TEST_ENV/venv"
"$V2_TEST_ENV/venv/bin/pip" install -r scripts/requirements-encrypted-upload-v2.txt
"$V2_TEST_ENV/venv/bin/python" scripts/test_encrypted_upload_v2_contract.py
python3 scripts/test_ble_e2e_disabled_config.py
git diff -- sdk
```

Expected: tests PASS and `git diff -- sdk` is empty. Do not run the JieLi build
on macOS.

- [ ] **Step 7: Document host-only status and commit**

Update firmware docs to distinguish allocated target UUIDs from the currently
registered GATT table and to state that capability advertisement remains off.

Commit:

```bash
git add scripts/fixtures/encrypted-upload-v2 \
  scripts/sync_encrypted_upload_v2_vectors.py \
  scripts/encrypted_upload_v2_reference.py \
  scripts/test_encrypted_upload_v2_contract.py \
  scripts/requirements-encrypted-upload-v2.txt \
  scripts/test_ble_e2e_disabled_config.py \
  AGENTS.md CLAUDE.md ARCHITECTURE.md
git diff --cached --check
git commit -m "test: add encrypted upload v2 firmware reference" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

---

### Task 9: Publish the Frozen Internal Documentation Contract

**Files:**
- Modify: `internal-docs/device/Encrypted-Upload-v2.md`
- Modify: `internal-docs/device/FIRMWARE_INTEGRATION_GUIDE.md`
- Modify: `internal-docs/device/BLE Reliable Transfer Design.md`
- Modify: `internal-docs/System Design v5.md`
- Modify: `internal-docs/CLAUDE.md`
- Modify: `internal-docs/llms.txt`
- Regenerate: `internal-docs/llms-full.txt`

**Interfaces:**
- Consumes: implemented manifest/vector revision and repository evidence from
  Tasks 1-8.
- Produces normative exact wire tables and evidence-based status language.
- Does not change public customer documentation because no public API or SDK
  behavior ships in this milestone.

- [ ] **Step 1: Replace candidate allocation language with frozen tables**

In the firmware guide, add the six `0406..040B` target characteristics, all
message codes, exact lengths/offsets, stable results, capability flags, and the
legacy `0x22` error. Label them:

```text
Allocated by encrypted-upload-v2-contract-v1; not registered or advertised by
production firmware.
```

Do not add the UUIDs to the released/current GATT table. Keep a distinct target
table so readers cannot infer deployment.

- [ ] **Step 2: Make the reliable-transfer design defer to the frozen source**

Replace candidate byte shapes with a link to the App SDK spec and manifest.
Retain the reliability state machine, and state that batch-v2 uses full UUID,
immutable generation, prefix digest, durable checkpoint revision, selective
window repair, and receipt-gated confirmation. Mark live streaming-v2 as
undefined.

- [ ] **Step 3: Update implementation status without overstating it**

Use this status split in `Encrypted-Upload-v2.md` and System Design v5 C10:

```text
Implemented: frozen machine-readable contract, deterministic vectors, Rust
structural codecs, App SDK native reference inspection, maintenance React
Native internal codecs, backend test-only verifier, firmware host-only
reference verifier, applied-v2_required legacy rejection.

Not implemented: public v2 API/session authorization signing, production
manifest/decryption/publication worker, SDK batch workflow selection/staging,
application providers, firmware bota_enc_v2 writer/reader, production v2 GATT,
durable firmware resume, direct raw-ciphertext WiFi/4G upload, receipt-gated
device deletion, streaming-v2, cohort enablement.
```

- [ ] **Step 4: Update the downstream impact matrix and LLM index**

Add an `Encrypted-Upload-v2.md` row to `CLAUDE.md` naming at least:

```text
bota/AGENTS.md, bota/ARCHITECTURE.md, bota/api/CLAUDE.md,
app-sdk/AGENTS.md, app-sdk/ARCHITECTURE.md,
react-native-sdk/AGENTS.md, react-native-sdk/ARCHITECTURE.md,
react-native-sdk/FIRMWARE_PROTOCOL.md,
firmware/AGENTS.md, firmware/CLAUDE.md, firmware/ARCHITECTURE.md,
FIRMWARE_INTEGRATION_GUIDE.md, BLE Reliable Transfer Design.md,
System Design v5.md
```

Update `llms.txt` summaries for the three changed design docs, then regenerate:

```bash
python3 scripts/gen-llms-full.py
```

- [ ] **Step 5: Search the entire documentation surface for changed tokens**

Run from the workspace root:

```bash
rg -n "BOTAENC2|BOTAEND2|BOTAAUT2|BOTAMNF2|BOTARCPT|B07A0004-000[6-9AB]|encrypted-upload-v2-contract-v1|ENCRYPTED_UPLOAD_V2_REQUIRED|BACKEND_PUBKEY" \
  internal-docs docs \
  --glob 'AGENTS.md' --glob 'ARCHITECTURE.md' --glob 'CLAUDE.md' --glob 'README.md' \
  app-sdk react-native-sdk firmware bota
```

Review every hit. Fix stale claims in the task-owned documents; record that
public docs need no edit because no customer-visible surface changed.

- [ ] **Step 6: Verify generated docs and commit**

Run:

```bash
cd /Users/zhangqi/ws/bota/internal-docs
python3 scripts/gen-llms-full.py
git diff --check
git status --short
```

Commit:

```bash
git add device/Encrypted-Upload-v2.md \
  device/FIRMWARE_INTEGRATION_GUIDE.md \
  'device/BLE Reliable Transfer Design.md' \
  'System Design v5.md' CLAUDE.md llms.txt llms-full.txt
git diff --cached --check
git commit -m "docs: freeze encrypted upload v2 protocol contract" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

---

### Task 10: Run the Cross-Repository Contract Gate

**Files:**
- Modify: `app-sdk/docs/superpowers/plans/2026-09-03-encrypted-upload-v2-protocol-contract.md`

**Interfaces:**
- Consumes: committed outputs of Tasks 1-9.
- Produces: reproducible evidence that all four consumers use one canonical
  vector digest and that no runtime behavior was activated.

- [ ] **Step 1: Compare all source revisions and digests**

Run:

```bash
cd /Users/zhangqi/ws/bota
V2_SOURCE_REVISION="$(git -C app-sdk log -1 --format=%H -- protocol/vectors/encrypted-upload-v2.json)"
V2_SOURCE_DIGEST="$(shasum -a 256 app-sdk/protocol/vectors/encrypted-upload-v2.json | awk '{print $1}')"
rg -n "$V2_SOURCE_REVISION|$V2_SOURCE_DIGEST" \
  react-native-sdk/protocol/vendor/app-sdk/encrypted-upload-v2.source.json \
  bota/api/tests/fixtures/encrypted-upload-v2/source.json \
  firmware/scripts/fixtures/encrypted-upload-v2/source.json
cmp app-sdk/protocol/vectors/encrypted-upload-v2.json \
  react-native-sdk/protocol/vendor/app-sdk/encrypted-upload-v2.json
cmp app-sdk/protocol/vectors/encrypted-upload-v2.json \
  bota/api/tests/fixtures/encrypted-upload-v2/encrypted-upload-v2.json
cmp app-sdk/protocol/vectors/encrypted-upload-v2.json \
  firmware/scripts/fixtures/encrypted-upload-v2/encrypted-upload-v2.json
```

Expected: all sidecars contain the same revision/digest and every `cmp` exits
zero.

- [ ] **Step 2: Run all contract and legacy regression suites**

Run:

```bash
cd /Users/zhangqi/ws/bota/app-sdk
cargo xtask protocol generate --check
cargo xtask encrypted-upload-v2 vectors generate --check
cargo test --workspace
npm run check:licenses
npm run test:fixtures
npm run test:react-native
npm run react-native:verify
npm run baseline:react-native
npm run sync:apple-fixtures
npm run sync:android-fixtures
npm run sync:apple-encrypted-upload-v2-vectors
npm run sync:android-encrypted-upload-v2-vectors
swift test --package-path platforms/apple
ANDROID_HOME="$HOME/Library/Android/sdk" platforms/android/gradlew \
  -p platforms/android testDebugUnitTest

cd /Users/zhangqi/ws/bota/react-native-sdk
npm test -- --runInBand
npm run typecheck
npm run lint
npm run build
npm run license-check

cd /Users/zhangqi/ws/bota/bota/api
npm run type-check
npm run lint
npx vitest run tests/unit/encrypted-upload-v2-contract.test.ts \
  tests/unit/encrypted-upload-policy.test.ts \
  tests/unit/encrypted-upload-legacy-recording-boundaries.test.ts

cd /Users/zhangqi/ws/bota/firmware
python3 scripts/test_ble_e2e_disabled_config.py
V2_TEST_ENV="$(mktemp -d)"
python3 -m venv "$V2_TEST_ENV/venv"
"$V2_TEST_ENV/venv/bin/pip" install -r scripts/requirements-encrypted-upload-v2.txt
"$V2_TEST_ENV/venv/bin/python" scripts/test_encrypted_upload_v2_contract.py
```

Expected: every runnable gate PASS; an unavailable Android emulator or JieLi
hardware build is reported separately and is not represented as a pass.

- [ ] **Step 3: Prove runtime activation did not occur**

Run:

```bash
cd /Users/zhangqi/ws/bota
test -z "$(git -C firmware diff --name-only HEAD -- sdk)"
! rg -n "startEncryptedUploadV2|selectEncryptedUploadV2|ENCRYPTED_UPLOAD_V2_CAP_BATCH" \
  app-sdk/frameworks/react-native/src \
  react-native-sdk/src/managers react-native-sdk/src/BotaClient.ts \
  bota/api/src/routes bota/api/src/workers \
  firmware/sdk
rg -n "g_transfer\.e2e_enabled = 0" firmware/sdk/apps/common/ble/le_trans_data.c
```

Expected: no runtime selector, route, worker, or firmware capability exists;
the legacy P10 hard-disable assertion remains present.

- [ ] **Step 4: Inspect every repository diff and commit boundary**

Run:

```bash
for V2_REPO in app-sdk react-native-sdk bota firmware internal-docs; do
  git -C "$V2_REPO" status --short
  git -C "$V2_REPO" log -5 --oneline
done
```

Confirm only the previously known `app-sdk/AGENTS.md`,
`app-sdk/ARCHITECTURE.md`, and `bota/infra/CLAUDE.md` user hunks remain
uncommitted. Do not push, merge, deploy, or enable a cohort in this plan.

- [ ] **Step 5: Mark the plan complete and commit the evidence update**

Mark Task 10 and all verified steps checked, then run in `app-sdk`:

```bash
git add docs/superpowers/plans/2026-09-03-encrypted-upload-v2-protocol-contract.md
git diff --cached --check
git commit -m "docs: record encrypted upload v2 contract verification" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

The next implementation milestone is the public backend v2
session/authorization/staging/manifest API and streaming decryption/publication
worker. It starts only after this contract gate is green and reviewed.
