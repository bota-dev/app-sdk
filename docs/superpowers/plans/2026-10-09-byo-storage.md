# BYO storage client integration

Owner-requested delivery: independent customer-storage upload, firmware WiFi/4G,
Apple/Android native SDKs and the React Native managed adapter. Keep Web/Flutter
extension boundaries compatible. This source change does not publish packages,
enable rollout metadata or establish physical acceptance.

1. Add independent BYO protocol/recovery types and test exact context, three WS
   reconnects, full-source fallback, durable receipt cleanup and restart recovery.
2. Implement native authenticated control requests, customer-only HTTPS byte
   transport and durable operation/receipt storage under the captured host scope.
3. Connect capability-gated BYO firmware document/transfer handling and opaque
   native material ownership; never send audio, manifests, receipts or signed
   upload URLs through React Native/Dart.
4. Verify public/native adapters, cancellation and old encrypted-v2 regressions;
   record build and physical limits separately from source completion.

New BYO JSON documents and WS frames are independent of the frozen encrypted-v2
binary profile. Reuse canonical BOTAENC2 file bytes only. A destination binds
once per recording; customer outages never route bytes into Bota storage.
Device/source deletion requires a verified receipt saved durably before cleanup.
The host continues to own authentication and current account/project scope.

## October 10 checkpoint

Steps 1–3 now have operational whole-file native HTTP/BLE callers and RN wiring,
not just recovery libraries. Actual firmware capability and signed physical
context gate key export. Native owns durable documents, exclusive journal lease,
original manifest, explicit renewal and receipt cleanup. Cancellation settles
before releasing device ownership. See [current integration/review](../../parity/byo-storage.md)
for exact entry points, tests and limits.

Rust recovery uses typed ABI `0x052d` (commands 13–15 for renewal/inspection),
checkpoint version 2 with version-1 restore, and independent BLE encode/decode
kinds `0x052e`/`0x052f`. Renewal persists UUID/revision before HTTP and cannot
independently grant cleanup. Protocol constants are manifest-generated.

Live capture producers and client HTTP/WS transport callers remain source gaps.
Target/mobile package builds, hardware power-loss and customer acceptance remain
separate from host source validation. No release or feature activation occurred.
