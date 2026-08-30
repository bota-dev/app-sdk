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
provisioning, and authenticated factory reset. Reset success is durably
journaled before receipt and replay can resume without resending the destructive
command. Recording transfer, upload, OTA, and device-log workflows remain under
development.

The `1.0.0-alpha.*` releases cover protocol and workflow-core milestones. They
do not replace the production React Native SDK and do not claim native
transport or physical-device acceptance. Stable `1.0.0` is reserved for the
React Native-consumable release. See the
[repository](https://github.com/bota-dev/app-sdk) for architecture,
compatibility, and release evidence.

Licensed under the MIT License.
