# Bota App SDK Core

`bota-device-sdk-core` is the portable Rust protocol core for Bota wearable
devices. It provides generated wire constants, bounded protocol decoders,
byte-exact serializers, stable models/errors, and typed workflow host
contracts.

```toml
[dependencies]
bota-device-sdk-core = "1.0.1"
```

This crate does not implement Bluetooth, HTTP, filesystem access, background
execution, or a Bota backend API client. Platform SDKs provide those host
capabilities and execute typed effects emitted by `WorkflowEngine`. The current
core implements deterministic discovery, connection recovery,
provisioning, authenticated factory reset, and resumable recording transfer.
Reset success is durably journaled before receipt and replay can resume without
resending the destructive command. Recording bytes remain in a host-owned sink;
the core checkpoints only byte and sequence counters, restarts the device stream
from sequence zero, and confirms device deletion only after the sink has passed
its durable integrity check. Upload handoff keeps destination data host-owned
behind opaque IDs and permits Bluetooth fallback only after a fresh device
status proves direct-upload ownership is inactive. Firmware update downloads
into an opaque host blob, streams 500-byte chunks
with the firmware's eight-packet flow-control window, treats reboot disconnect
as expected, reuses connection recovery, and verifies the target version after
reconnect. A transfer retry reuses the host blob but restarts device delivery at
offset zero because current firmware recreates its staging file on every start.
The host must establish any firmware-required OTA authorization before starting
this workflow. Device-log streaming subscribes before start, permits
one owner, reuses the bounded line decoder for sequence-gap and UTF-8 recovery,
and deterministically stops or releases the subscription on terminal paths.
The workflow compatibility claim is guarded by 29 schema-validated scenarios
and 25 referenced Rust tests; see `protocol/workflows/` in the repository.

The `1.0.0-alpha.*` releases cover historical protocol and workflow-core
milestones. The stable App SDK family began with the Apple package in `1.0.0`;
the Rust core is an internal implementation crate and is not published to
crates.io. The App SDK does not replace the production React Native SDK until
that facade passes its migration gates. See the
[repository](https://github.com/bota-dev/app-sdk) for architecture,
compatibility, and release evidence.

Licensed under the MIT License.
