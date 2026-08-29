# Bota Device SDK Core

`bota-device-sdk-core` is the portable Rust protocol core for Bota wearable
devices. It provides generated wire constants, bounded protocol decoders,
byte-exact serializers, stable models/errors, and typed workflow host
contracts.

```toml
[dependencies]
bota-device-sdk-core = "1.0.0"
```

This crate does not implement Bluetooth, HTTP, filesystem access, background
execution, or a Bota backend API client. Platform SDKs provide those host
capabilities and execute the typed effects emitted by future workflow reducers.

The initial `1.0.0` release covers the pure protocol core. It does not replace
the production React Native SDK and does not claim native transport or
physical-device acceptance. See the
[repository](https://github.com/bota-dev/app-sdk) for architecture,
compatibility, and release evidence.

Licensed under the MIT License.
