# Firmware Interoperability Fixtures

These files accompany [FIRMWARE_PROTOCOL.md](../../../FIRMWARE_PROTOCOL.md).
All keys are **public test keys**, never production enrollment, signing or
trust anchors. Fixed randomness is for reproducible fixtures only; real devices
must use their approved CSPRNG. Fixture validity uses the embedded test clock,
not the current wall clock.

| File | Coverage |
| --- | --- |
| [recording-markers-v1.json](recording-markers-v1.json) | MarkerBody52 accepted/rejected encodings and event hashes, including values above JavaScript's safe integer range; codec-only evidence |
| [recording-stream-direct-start.json](recording-stream-direct-start.json) | Device P-256 key grant, signed stream/marker authority, one-marker X25519 envelope/ACK and exact START response |
| [recording-stream-c-direct.json](recording-stream-c-direct.json) | Production C direct-owner output paired with the preceding START fixture: encrypted audio, stop, zero-marker seal, canonical snapshot and final proofs |
| [recording-stream-audio-ack.json](recording-stream-audio-ack.json) | Exact signed audio-chunk durable ACK and document/chain binding |
| [recording-stream-completion-interop.json](recording-stream-completion-interop.json) | Completed zero-marker capture, final proof issuance after capture expiry and exact snapshot/cross-proof bindings |

The direct-start fixture's `scenarios.oneMarker` tests one-marker cryptography;
the paired C-direct capture is intentionally a **separate zero-marker scenario**
using the same test admission. Do not merge their marker/seal requests into one
capture. In the completion fixture, test time is 1100, capture expired at 1000,
and final proofs expire at 4700. Acceptance at 1100 and rejection at 4700 are
intentional, not a bypass of time verification.

The existing [v2 transport vectors](../../../protocol/vectors/encrypted-upload-v2.json)
and [base contract](../../superpowers/specs/2026-09-03-encrypted-upload-v2-protocol-contract-design.md)
cover inherited BATCH transport. These files do not claim an end-to-end physical
BATCH capture or power-cut qualification.

Run the dependency-free fixture integrity/signature/binding check from repo root:

```sh
node docs/firmware/vectors/verify.mjs
```

[SHA256SUMS.json](SHA256SUMS.json) pins the exact fixture bytes. The check verifies
those hashes, document sizes/magic/kinds, P-256 low-S signatures and domain
separation, marker digest, direct START Base64 identity, snapshot and final
proof bindings, and mutated signature/context/proof rejection. It does **not**
implement HPKE or a firmware verifier. Firmware integrators must independently
open P-256 grants and X25519 marker envelopes and authenticate/decode the audio
with their production crypto implementation. Passing this checker alone is not
full protocol conformance.

## Required rejection and recovery cases

- Wrong environment, tenant/device, recording UUID/generation, mode, owner,
  context or request UUID; unknown signing key; untrusted/expired time.
- DER/high-S/modified signature; wrong signature domain; HPKE info/AAD mismatch;
  changed ciphertext; valid public-key encryption with wrong origin HMAC.
- Reused nonce/producer handle, changed bytes under an existing request/index,
  marker ID conflict, missing sequence, overlap, integer overflow and excessive
  signed limits. Reject before allocation or narrowing.
- Marker ACK as final completion, audio ACK as final audio proof, BATCH/STREAMING
  proof substitution, changed snapshot, omitted zero-marker seal, incomplete
  audio despite sealed metadata, mismatched final media endpoint.
- Exact response-loss retries preserve ciphertext/request IDs and do not flash
  twice; late ACK after stop produces no new white flash.
- BATCH disconnect after kind6 COMMIT but before CONFIRM; terminal flush/read-back
  failure; restart with missing/corrupt terminal; lost completion response and
  partial sidecar cleanup. No deletion without exact dual proof and local state.
- STREAMING stop timeout, full RAM, credential epoch change and power loss leave
  an honest pending/incomplete result, never invented local BATCH recovery.

## Provenance and verification scope

Fixture bytes are copied unchanged from the corresponding software
interoperability fixtures at implementation revision
`12f9ec133cb07bb87b3a8bb83fcad96e3b4cf913` (2026-10-10). This is a source revision,
not a package version or released wire-profile claim. SHA-256 pins above detect
accidental drift. The public pack includes only deterministic test material,
with no service credentials, production keys or internal deployment paths.
