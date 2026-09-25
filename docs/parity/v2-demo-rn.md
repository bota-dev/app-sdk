# Demo v2 React Native Bridge Review

Scope: independent review of `src/client.ts`, `src/index.ts` and
`src/specs/NativeBotaDeviceSDK.ts` in `frameworks/react-native`. Implementation
edits are limited to `src/client.ts`; the parent owns native adapters, exports,
the TurboModule spec and Codegen generation. This is unpublished source-level
evidence, not physical-device or release acceptance.

## Metadata Boundary

`recordings.listPendingRecordings(device)` retains native catalog identity.
Legacy rows map to the existing `DeviceRecording` shape; v2 rows have
`storageFormat: 3`, canonical lowercase UUID, unsigned u32 generation,
lowercase SHA-256, nonzero ciphertext length and plaintext length as exact u64
decimal strings. Catalog timestamps and durations are validated before mapping
to `Date` and safe integer milliseconds. Legacy numeric fields must also be
nonnegative safe integers, with a representable timestamp.

The JS mapper rejects malformed UUIDs, number-valued decimal strings,
out-of-range values and ambiguous profile tags. It projects only declared
metadata, never arbitrary native properties. It neither invents v2 identities
from legacy IDs nor falls back to legacy listing after a catalog error.
Native owners remain responsible for catalog assembly and legacy alias policy.

Strict contract tests pin the complete v2 and mixed-catalog aliases, including
the referenced legacy metadata type, both event types, method parameters and
return shapes. The additive native methods are `listPendingRecordings`,
`cancelEncryptedRecordingV2` and `releaseEncryptedUploadV2Material`. Only the
catalog method returns metadata; the others return void promises. The tests
exclude audio, payloads, credentials and opaque security documents from this
boundary and scan the JS client for native v2 wire opcodes/characteristics.

## Cancellation Ownership

The fifth sync argument accepts `signal` and `operationId`; the provider
context receives that same operation ID. Pre-abort and setup-time abort do not
start native work. Operation-specific cancellation is awaited, and progress
stops immediately after abort. Terminal or foreign-operation callbacks do not
invoke the provider, and a late provider result releases its native material
registration without resolving an obsolete request.

Every listener removal is attempted even when one throws. Both synchronous
native cancellation throws and rejected cancellation promises, including
falsey rejection reasons, fail the operation with a stable sanitized message.
Native completion remains authoritative: an abort after the native confirmation
boundary may still resolve successfully once cancellation has joined. JS does
not infer whether physical confirmation occurred.

## Verification

The full Expo consumer exposed a dependent-pod module-map path left behind by
the existing static SwiftPM workaround. The SDK now updates both aggregate and
dependent-pod cached xcconfigs, so Expo's later macro integration preserves the
flattened path. `ruby test/apple-spm-workaround.test.rb` covers this overwrite
regression, unrelated flags, dynamic-linkage exclusion and repeated application.

The final native bridge gates passed 46 Swift adapter tests and 50 Android
adapter tests, plus Android release lint and AAR assembly. Bulk cancellation
now cancels and joins every exact v2 child task/job before returning, including
a provider request still waiting for material. Both platforms retain the
operation-scoped nonce lease and idempotent material-release checks.
The Android consumer and nested Apple package build output directories are
ignored separately from checked Codegen artifacts, so local compilation and
verification cannot add generated build files.

On 2026-09-24, using Node 22.23.2:

```sh
npm run build
npm run typecheck
npm test
```

Fresh build/typecheck and all 140 RN tests passed. `npm test` rebuilds first and
includes the existing read-only Codegen consistency check; this review did not
write Codegen output. Seven new failure cases were observed red before their
fixes: catalog coercion/UUID checks, legacy validation, undeclared property
projection, progress after abort, interrupted cleanup, falsey cancellation
rejection and synchronous cancellation throws. Fifteen focused bridge tests
also cover successful cancellation ordering and late callback ownership.

The requested fixture follow-up changed the canonical unknown capability bit
from `0x100` to `0x400` because bits 8 and 9 are now known. The generator test
was observed red, then all five vector-generator tests passed. Canonical JSON,
Rust digest and both native resources/test pins were synchronized; see
`v2-demo-protocol.md` for the digest and Rust verification commands. Release
history was not regenerated. After synchronization, all 268 Rust workspace
tests, Clippy, formatting, protocol/vector generation checks, both platform
fixture checks, ABI header hash and C/Swift ABI smokes passed.
No crypto implementation, trusted-time behavior,
native workflow, Demo source or published version changed in this review.

Documentation-token searches covered internal/public docs and repository
AGENTS/ARCHITECTURE/README files. Broader native and root documentation remains
with the parent and native owners. Device, native-integration and publication
acceptance must be established by their separate test gates.
