# Maintenance SDK Parity Recovery

**Goal:** Close the diagnostics, restart-safe upload, and lost-ACK resume gaps
against maintenance SDK commit `318974f925a573cf04b0d624978bee04784af09b`.

**Design:** Preserve the Rust protocol authority, typed native bridges, native
recording files, connection-generation ownership, and exact backend completion
boundaries. Frozen 0.0.65 compatibility remains protected while newer additive
contracts are tracked separately. Published beta.1 is immutable; this work is
unpublished source, not physical-device or application-rollout acceptance.

## Work

- [x] Diagnostics: reproduce decoder/read/ACK gaps; implement bounded Rust
  decoding and typed ABI, native serialized read/ACK ownership, RN public
  compatibility and bridge methods. Verify malformed/incomplete chunks,
  pending-log overlap, timeout, disconnect, cancellation, and exact event IDs.
- [x] Upload recovery: reproduce restart/credential/completion gaps; persist
  non-secret identity only, refresh exact-scope credentials, preserve native
  files until durable backend completion, cancel stale work, and recover queued
  work without sending bytes through JavaScript. Explicitly document any
  maintenance byte-store API adaptation instead of silently ignoring it.
- [x] BLE resume: reproduce lost WINDOW_ACK on Apple and Android; accept one
  strictly older locally proved device checkpoint, persist before truncation,
  and reject foreign/newer/corrupt/repeated replies. Preserve cancellation
  ownership and document the existing Apple live disconnect barrier limit.

  Apple: 92 focused tests; final package 226 tests, 9 physical skips, no failures.
  Android: final 201 debug and 201 release unit tests passed. The final native
  artifacts were used by the RN consumer builds.
- [x] Parity gates: protect old API behavior and pin the current maintenance
  source with the added regression coverage. Run Rust/ABI, native, RN, Codegen,
  and relevant package verification without changing immutable release assets.
- [x] Documentation/review: update source status, migration notes, cross-system
  and public SDK docs; independently review integration. Keep unverified gates
  explicit. Do not upgrade Demo/Bota One or publish as part of this source fix.

Final local verification and unclosed acceptance boundaries are recorded in
[Maintenance Parity](../../parity/README.md). These completed source tasks do
not constitute full maintenance API or physical-device parity.

## Isolation

Implementation uses a clean worktree because the normal checkout contains
unrelated selected-device Web work. Native resume, upload recovery, and
diagnostics have disjoint owners; shared RN bridge edits are integrated by the
coordinator. Tests are added and observed failing before production changes.
