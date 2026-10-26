# Encrypted device token provisioning

## Plaintext/encrypted compatibility (unreleased)

The current byte and API contract is [device-token-v1](../../protocol/device-token-v1.md).
Rust accepts exactly one raw token or envelope and selects the corresponding
characteristic before writing. RN's material broker and compatibility manager,
and the Web provider, enforce the same exclusive choice. No failed encrypted
operation falls back to plaintext. Apple/Android/Flutter retain their existing
optional envelope and raw-token fields; no ABI renumbering is needed.

The RN runtime is regenerated from this Rust source on the required Linux
1.98.0 toolchain. Compatible Apps and firmware must accompany the qualified SDK
release before a running backend switches to default plaintext. Published
package pins and physical acceptance remain separate.

## Historical implementation checkpoints

## Mandatory encrypted delivery — 2026-10-22

The user approved a direct cutover with no legacy compatibility. Bind and refresh
require `credential_delivery: "hpke_v1"`, independently trusted device enrollment
and configured signing trust. Their only credential response is
`credential_envelope`; there is no raw `device_token` response or fallback.
Missing/mismatched/revoked trust, missing mode, unsupported SDK/firmware and invalid
envelopes fail. Claim and serial-only provision polling are retired (claim: HTTP410; provision: HTTP410 when mounted, otherwise HTTP404),
with no Manufacturing transition, binding mutation or credential issuance.

SDK shared Rust accepts only an envelope; the old ABI token slot must be empty.
The old GATT UUID stays reserved but always rejects; its installer and build opt-out
are deleted. Bind → provision → confirm/abort still uses the same user steps and
request rounds. This changes token delivery only: device storage and later HTTPS
Bearer authentication retain the decrypted `device_token`. Existing valid stored
tokens are not erased or automatically rotated. Direct HTTP activation remains
unimplemented; retirement of the insecure polling route does not create one.

This is an unreleased coordinated backend/SDK/App/firmware change. Migration124,
trusted manufacturing enrollment, matching signing/device keys, qualified SDK
release adoption and physical acceptance precede deployment. Source/test evidence
is distinct from publication, installation and production enablement.


Status: unpublished source candidate, 2026-10-21. The canonical wire contract is
[device-token-v1](../../protocol/device-token-v1.md). The single cross-repository
completion checklist is `internal-docs/device/Device-Token-Envelope.md`.

## Application contract

Request `credential_delivery: "hpke_v1"` in the existing bind request and pass
`credential_envelope.data` without decrypting or persisting it. React Native's
compatibility facade accepts `devices.provisionEnvelope(device, data,
environment, options)`. Existing deprovision/retry and confirm/abort ownership
remain unchanged. Applications must establish SDK support before starting bind.

The material-provider contract requires `credentialEnvelope` at runtime:
canonical unpadded base64url on React Native, bytes on Web/Apple/Android/Flutter.
`deviceToken` must always be empty; optional ABI encoding only preserves field
numbering and does not permit omission for a successful operation. Rust rejects mixed/absent credentials,
invalid framing bounds and unsupported MTU before writing either credential
characteristic. An encrypted operation never retries through the old plaintext
characteristic. The old ABI slot is reserved and must be empty; plaintext material is rejected for every device. There is no legacy provisioning execution path.

The shared Rust workflow writes the existing endpoint, then bounded envelope
fragments to B07A000A, then awaits the existing provisioning result. The envelope
adds BLE fragments, not another application request or user interaction. SDKs
do not hold the device private key. HTTPS refresh returns the same envelope with
purpose 2; the existing initial BLE provisioning path admits purpose 1 only.

## Implementation review and evidence

| Requirement | Evidence | Status |
| --- | --- | --- |
| One protocol owner and stable old handles | Manifest generation, Rust encrypted workflow regression, firmware GATT-prefix test | Source checked |
| Opaque bounded material; no plaintext fallback | Rust and RN material validation; generated Web WASM envelope test | Source checked |
| Existing lifecycle and confirmation | RN existing lifecycle suite; Web envelope test confirms the existing attempt | Source checked |
| Shared native material | FFI field 223, Swift/Kotlin adapters, Apple service discovery, Pigeon 28.0.0 generated Dart/Swift/Kotlin | Implemented; full platform lanes open |
| Android source/binary constructor compatibility | Kotlin 2.1.20 model compilation and generated API block retain original constructor | Model check passed; full Android API lane open |
| Actual RN artifact | Generated on x86_64 Linux/Rust 1.98.0; source provenance and real encrypted workflow pass | Local artifact checked |
| Production package and device behavior | Exact candidate CI, packaged consumers, BLE/WiFi/LTE devices | Not qualified |

All shared Rust workspace tests and strict Clippy pass. Web build/types and all 417
tests pass, including the generated-WASM envelope test. RN full verification (package, Codegen, types, build, license and all 576 tests)
passes against the final generated runtime, including encrypted fragmentation.
Native Rust and generated JS agree on 146 RPCs; the standalone Node VM passes
777 checks without WebAssembly. This is not a pinned Hermes runtime execution.
The native C and Swift FFI smoke tests and 118 tooling tests pass. Swift
requires an explicit writable module cache (`-module-cache-path /private/tmp/token-swift-cache`);
the default cache denial produced a misleading compiler/SDK compatibility
diagnostic. The iOS SDK is absent, so full Apple platform lanes remain open.
Full Android SDK and Flutter SDK are also absent. Pigeon regeneration uses the
official Dart 3.13.2 runtime with the repository's exact Pigeon 28.0.0 pin; this
is not a substitute for full Flutter analysis and device tests.

## Reusing the previous Linux build environment

The local Colima default profile already contains an x86_64 Linux VM and cached
`bota-sdk-generator:ble-name` image, with Rust 1.98.0, Node 22.23.2 and Binaryen
132.0.0. Start that existing VM with `colima start --activate=false`. Select its
Docker socket explicitly, mount the candidate read-only, copy to a container
workspace and run `npm run react-native:generate-js-core`. The image has a shell
entrypoint; override it with `--entrypoint /bin/sh` when supplying a script.
Preserve the prescribed single-core Binaryen setting and source remapping.
The previous successful script also writes a Node preload calling
`require('node:v8').setFlagsFromString('--liftoff-only')` and exports
`NODE_OPTIONS=--require=/tmp/bota-v8-flags.cjs`; without it the emulator can
crash V8 during wasm tier-up. This changes the host execution strategy, not the
Rust or Binaryen compiler flags.
Copy only the generated `core.ts` back, verify source provenance, then execute
the generated runtime tests. Never update the provenance comment by hand.

## Remaining boundaries

Keep published dependency pins unchanged until the candidate is qualified and
released. This work does not provide secure storage on the device, a new replay
ledger, stronger bind confirmation, or certificate private-key confidentiality.
No migration, trusted enrollment, package publication or physical installation
has been performed. The direct design review follows CONTRIBUTING's fallback
because the shared compound-engineering skill is unavailable.

## Final generated artifact

- Rust source provenance: `877e6ed14de628d4c4f82f52abed2e8d36e69f7f9643f54b70d1e20a7d0cfc8b`.
- Generated `core.ts` SHA-256: `95d5ec1ed39ddb44d3cd4564bb60decbf5815f075923042fd1b3e9bcd28203ed`.
- Linux generator image: `sha256:41654aa3645fe4eb4baa882f36cbef5ffdce42bbb2f58c07d3a98727af604a28`.
- Generation succeeded. The container's subsequent parity command lacked the RN
  `lib` build directory; verification was completed successfully in the host
  candidate after its normal RN build. The retained build script now uses the
  compiler-free provenance check immediately after generation.

Full native platform lanes, pinned Hermes execution, exact release/package
qualification and physical BLE/WiFi/LTE acceptance remain outstanding. Source
implementation is complete; this document does not authorize publication.


## Separate delivery and authentication fields (2026-10-21)

Final contract: `credential_envelope` is the versioned ciphertext object for
binding and refresh delivery; `device_token` means only the raw authentication
credential. The encrypted response does not contain `device_token`. The proposed
version-prefixed string in that field was withdrawn before release because it
mixed delivery ciphertext with usable credentials. Apps reject that obsolete
representation, plaintext and mixed fields. They validate format, encoding and
canonical unpadded base64url, then pass envelope data to the SDK without decryption.

After verification/decryption, firmware stores the original `dtok_*` under its
existing token interface. Following binding confirmation, authenticated HTTPS
requests carry it in `Authorization: Bearer`; TLS encrypts the request on the
network. Delivery encryption is not reused as per-request authentication.
Recording/content encryption is an independent contract. No device storage,
heartbeat or upload token names are changed. Firmware binary envelope, HPKE
inputs and shared SDK runtime remain unchanged by this field correction.

Verification: the updated issuer regressions failed against the prefixed-string
response before implementation. All 83 backend delivery/crypto/service/controller
tests pass after the change; both App parser and binding-lifecycle checks pass.
API and One app types, regenerated OpenAPI and five changed MDX pages are checked
separately from release, deployment and physical acceptance. Notion's six related
pages use the same distinct-field contract. No migration/enrollment/deployment
or package release is performed.

## Direct-cutover verification — 2026-10-22

| Requirement | Implementation evidence | Verification |
| --- | --- | --- |
| No plaintext issuer or unregistered-device exception | Required hpke_v1 on v1/Dashboard bind and refresh; non-null trusted profile; only credential_envelope returned | 122 focused backend tests, API typecheck; 115 device read/auth contract tests; 3 real HTTP tombstone cases |
| No side effects through retired bootstrap | Claim returns HTTP410; provision polling is a static HTTP410 tombstone when mounted (otherwise HTTP404); service guards reject before database/Manufacturing work | Enrolled/unregistered negative cases verify no token creation/revocation or ownership change |
| No plaintext SDK installation | Shared Rust has one credential-envelope branch; RN material broker/manager and Web provider reject raw or mixed credentials | Rust workspace 443 tests, strict clippy and protocol freshness pass; Web 417 full tests plus new raw-only negative; both Apps parser/lifecycle checks pass |
| Preserve reset recovery and durable installation | New envelope entry retains RESET_PENDING and reset resume; old UUID always returns invalid-token | Crypto, framing, installer fault injection and all 14 reset-close-loop cases pass |
| Coherent protocol references | Public bind examples and generated OpenAPI use the required envelope; legacy maintenance SDK example no longer provisions raw tokens | Six MDX files compile; internal full OpenAPI bind/refresh/claim checked; six Notion pages updated and read back |

The compound-engineering skill is unavailable in this session. This requirement /
implementation / evidence review is the repository-prescribed direct fallback.
Final RN generated-core adoption and final firmware link evidence are recorded
in the completion entry below. Formal publication,
full native platform qualification, trusted production enrollment/deployment
and physical BLE/WiFi/LTE acceptance remain separate and unperformed.


## Final cutover artifacts — 2026-10-22

The canonical RN generator completed on the existing x86_64 Linux image with
Rust 1.98.0, Node22 and Binaryen132. The adopted 4,017,043-byte core has source
fingerprint `2af9294f2be4334d0fd9d3754e7f75e77e66b114e581485802b125514ac93b88`
and artifact SHA-256
`7f9a32c30e24966d50ab0e9c22a7503386e30f1a668921bdab4c9d8849621b65`.
Its actual generated runtime rejects plaintext before subscription/write and
relays only the encrypted characteristic. Native Rust and generated JS agree
on all 146 RPCs. The final RN verification passes all 579 tests and the license gate. The standalone bundle passes 777 Node VM checks; this is not
an actual Hermes/phone execution result. The final DEBUG=0 JieLi ELF is
20,484,304 bytes, SHA-256
`16bb1935be740eb99e223926de3da0051be77a0cda4ff6d89bd4796fea292e09`.
The final link includes preserved RESET_PENDING/resume behavior in the encrypted
entry. No package publication, device flashing, production migration/enrollment
or deployment was performed. Both Apps retain published dependency pins until
qualified release adoption; incompatible old clients cannot bind after cutover.


CI preparation follow-up: the workflow evidence now points to the existing plaintext-rejection test and its InvalidInput result; no production crypto or generated runtime changes. The Dart file is formatted with the package language version 3.11. All 16 workflow tooling tests and references against the exact frozen maintenance source pass; full hosted rerun remains separate.

Workflow fixture follow-up: regenerated Apple and Android resources from the
canonical encrypted-only provisioning scenario; Flutter's typed trace now expects
`invalidInput` for rejected plaintext material. Both 33-scenario freshness checks
and Dart 3.11-language formatting pass. Hosted native/Flutter reruns qualify the
updated fixture resources; no core runtime or generated RN artifact changed.

### Flutter post-publication candidate qualification

Hosted CI at `92b5c12` passed all 87 Flutter tests and built both Android release
APK and iOS release App. It then correctly rejected the changed package against
the published beta.20 release example. That example remains byte-identical to
`v2.0.0-beta.20`; source work must not rewrite a published inventory.

PR/main CI now selects a separately checked `release/candidates/2.0.0-beta.20.json`.
It is generated from the committed package source through the canonical archive
and manifest tools. The inventory still contains 59 files; only the nine encrypted
credential adapter/generated/model/test files differ from the published package.
The same strict archive and file hash comparison applies. Release `--check` and
`--write-example` continue to select the historical release example, and occupied
registry versions still reject changed bytes. No version bump or publication is
part of this repair; changed source requires a new version before release.

Direct design review: encrypted-only delivery and wire behavior are unchanged;
source-candidate integrity and published-history immutability remain enforced.
All 152 release tooling tests pass, including CI/release template selection and
changed-byte rejection. Canonical archive verification and exact template matching
pass locally. The complete hosted candidate rerun remains the final build gate;
physical device acceptance remains separate.

The complete hosted Flutter candidate and candidate inventory passed at
`1a2ea977`. The remaining Rust readiness failure was a source-layout assertion
that still expected the release-example path inline in the shell script. It now
checks the version/mode-aware selector invocation; the executable occupied-version
rejection remains intact, and 19 local template/publication checks pass. Full Rust
workspace and hosted readiness verification are repeated for this test-only fix.
