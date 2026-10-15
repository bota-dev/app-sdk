# Authenticated model hints for legacy generic settings

October 15 source correction. The normal Demo connection reports GATT Model
Number `BOTA_DEV` while its authenticated paired-device record reports Pin,
binding generation 3. A separate normal One read at 20:27:08 UTC confirms
`BOTA_DEV`, firmware 1.0.18 and bound Pin/generation 4. Neither read performs a
model write. Settings reads succeed because decoding is model-neutral;
writes reject because the Rust encoder needs a known model for normalization.
That physical observation precedes this correction and does not qualify it.

`createBotaReactNativeJsRuntime` accepts optional
`resolveBoundDeviceModel(serialNumber, context)`. The host returns
`{serialNumber, model, bindingGeneration}` or `null`, using its authenticated,
exact current project/device binding. The hint contains no credentials. The
host must check account/project/serial/binding authority, honor cancellation,
and retire the runtime when that scope or model changes. Persisted display
metadata, advertisements and an arbitrary caller-edited `ConnectedDevice`
cannot establish this authority.

The existing Rust `encodeConnectionSettings` codec accepts the optional hint.
It requires the exact serial, a positive JavaScript-safe integer generation
and a known model. Only the documented legacy generic string `BOTA_DEV` may
fall back to the hint. Other unknown strings remain rejected. A known GATT
model works without a hint; a conflicting known hint is rejected. Note uses
the existing shared normalization that disables cellular upload/heartbeat and
removes cellular upload priority. The raw connected GATT identity is preserved.

JS controls obtain the hint within the existing joined operation and check
the captured connection generation, scope and cancellation before and after
awaiting it. The final write uses the same ordered GATT lane. The installed
version-1 OS ports, native Codegen contract, settings wire format and firmware
are unchanged. This is not a new capability negotiation profile: the released
12-byte v0x02 format cannot represent the target desired/applied policy and
capability evidence described in Connection Management §8.3.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Registry/manufacturing identity remains authoritative; generic names never imply Pin | Explicit authenticated host hint; Rust exact-serial/generation/known-model guards | Source implemented; app wiring and physical qualification pending |
| Shared policy remains Rust-sourced | Existing Rust codec extension; existing model normalization; no handwritten generated core | 68 offline native Rust tests pass; canonical Linux regeneration pending |
| Scope changes cannot submit a stale settings write | Real controls regression for pending hint cancellation and physical rebind; strict TS | Local lifecycle regression/typecheck pass; generated-core positive/negative regressions are red against the preceding core |
| Native and device compatibility stays explicit | No OS-port/Codegen/wire-format change; only BOTA_DEV fallback | Source matched; fresh exact-source CI/Hermes and normal settings read-back pending |

Current exact-main `9e7c54d8` qualification remains historical evidence for the
preceding core. No publication, app delivery, firmware installation or physical
settings acceptance is established by this source checkpoint.
