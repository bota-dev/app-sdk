# BLE find device

The confirmed requirement is a direct authenticated BLE start/stop action, with
both light and vibration, a bounded local duration and truthful device receipts.
The canonical cross-repository checklist is
[bota find review](https://github.com/bota-dev/bota/blob/feat/find-device-command/docs/reviews/find-device-command.md).

Rust owns the new service codecs, validation and receipt interpretation. The
JavaScript runtime transports those bytes through its existing connection owner,
subscribes before writes and uses a three-second acknowledgement deadline. The
compatibility manager serializes nonce acquisition through command completion;
a subsequent explicit stop acquires fresh authority. No retry replays a start.

The application fetcher must enforce current account/project/binding scope.
The backend signs a single-use, action-specific grant without a cloud queue or
heartbeat requirement. Firmware advertises support only with qualified light and
haptic adapters. Native-only adapters remain unavailable for these additive
methods; there is no silent fallback to recording commands or cloud delivery.

Direct design review: the optional compound-engineering skill is unavailable.
The implementation preserves existing handles and exported recording behavior,
fails closed on old firmware, matches exact request IDs and keeps physical
success distinct from a successful write. Verification: Rust core find tests 3, JS binding tests 69, full RN facade/host
regression tests 533 and RN strict types passed. The committed generated core
comes from Linux CI run 38854313911; compiler-free provenance matches current
Rust source hash b6190463d4b13442952f6b35eaa21c43eba2776b184c821a1e5a0b8f989cc8a0.
Exact final CI rebuild and physical board qualification remain release gates. No package publication or installed-device result is
claimed. The existing public beta.18 cannot execute the new methods.
