# Firmware Marker Protocol Documentation Review

Date: 2026-10-10. Scope: public firmware integration documentation and public
test-only fixtures. No firmware, backend or SDK runtime behavior changes.
The compound-engineering skill is unavailable in this session; the required
design/conformance comparison is recorded directly below.

| Requirement | Implementation evidence reviewed | Result | Remaining verification |
| --- | --- | --- | --- |
| Local terminal before deletion | Firmware `encrypted_upload_v2_admission.c`: `bota_enc_v2_admission_marker_receipt` verifies/persists/read-backs on kind6 COMMIT; `bota_enc_v2_admission_confirm` checks terminal before cleanup | Entry sequence and recovery appendix now match | Target power-cut and interrupted cleanup acceptance |
| Complete marker security format | Backend marker contract/crypto codecs; firmware marker export; fixed marker/stream fixtures | Context176, body52, signed/encrypted envelopes, domains, body offsets, snapshots and limits documented | Third-party implementation with provisioned production trust/time |
| Direct STREAMING contract | Backend stream contract/crypto, validation/router/controller/runtime; firmware direct capture worker | All 11 device routes, START fields/capabilities, P-256 grant, X25519 markers, ACKs, stop/seal, proof expiry/refresh and retry restrictions documented | Deployed service/device integration and target builds |
| Preserve App and legacy boundaries | SDK protocol manifest/native providers at `c9b8ae0`; firmware current ownership checks | No new remote marker operation or BLE stream relay; BATCH proof-kind1 and STREAMING proof-kind2 stay separate | Published SDK/App native rebuild and device acceptance |
| External reproducible evidence | Five unchanged deterministic implementation fixture files with SHA-256 inventory; public Node checker | 13 signed documents pass domain/signature/binding checks; negative signature/domain/context/snapshot/proof mutations reject | Checker does not implement HPKE; independent firmware crypto validation required |

Source comparison used backend `12f9ec133cb07bb87b3a8bb83fcad96e3b4cf913`,
firmware `2c082f80b6756c03b9783d2cddd87db6439d9b97`, and the SDK source revision
above. These are implementation revisions, not assertions of package release.

Validation performed for this documentation update:

- `node docs/firmware/vectors/verify.mjs`: five fixture hashes and 13 signed
  documents, identity/content bindings and negative mutations pass.
- Backend existing suites `recording-markers-contract`,
  `recording-stream-direct-interop`, `recording-stream-completion-interop`, and
  `recording-stream-audio-ack`: **4 files / 47 tests pass**. These exercise real
  crypto and C-produced fixtures; this run is not a fresh C compilation.
- Relative documentation links, English-only public text and `git diff --check`
  checked. GitHub CI for the pushed documentation revision is tracked on its PR.

No deployment, package publication, profile activation, target firmware/mobile
build or physical radio/WRGB test is included. The board LED driver still needs
hardware details. The public entry point retains these availability boundaries.
