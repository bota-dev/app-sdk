# Bota Device SDK Core

`bota-device-sdk-core` is the portable Rust protocol core for Bota wearable
devices. It provides generated wire constants, bounded protocol decoders,
byte-exact serializers, stable models/errors, and typed workflow host
contracts.

```toml
[dependencies]
bota-device-sdk-core = "1.0.0-alpha.1"
```

This crate does not implement Bluetooth, HTTP, filesystem access, background
execution, or a Bota backend API client. Platform SDKs provide those host
capabilities and execute typed effects emitted by `WorkflowEngine`. The current
prerelease implements deterministic discovery, connection recovery,
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
this prerelease workflow. Device-log workflow remains under development.

The `1.0.0-alpha.*` releases cover protocol and workflow-core milestones. They
do not replace the production React Native SDK and do not claim native
transport or physical-device acceptance. Stable `1.0.0` is reserved for the
React Native-consumable release. See the
[repository](https://github.com/bota-dev/app-sdk) for architecture,
compatibility, and release evidence.

Licensed under the MIT License.
