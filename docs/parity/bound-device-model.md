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
| Registry/manufacturing identity remains authoritative; generic names never imply Pin | Explicit authenticated host hint; Rust exact-serial/generation/known-model guards | Matched in source and positive/negative regressions; authenticated app wiring and physical qualification pending |
| Shared policy remains Rust-sourced | Existing Rust codec extension; existing model normalization; exact Linux-generated core | Matched: 68 offline native Rust tests, strict Clippy and canonical source/provenance verification pass |
| Scope changes cannot submit a stale settings write | Real controls regression for pending hint cancellation and physical rebind; strict TS | Matched locally: all 493 RN tests and normal module/CommonJS/types build pass |
| Native and device compatibility stays explicit | No OS-port/Codegen/wire-format change; only BOTA_DEV fallback | Matched in source; 146 native/generated RPC comparisons and 768 isolated Node checks pass; hosted pinned Hermes and normal settings read-back unverified |

The source-only candidate `7ab484a625527729b2e9eee6c0d890c15f0b81dd`
intentionally retains the preceding generated core. Its two new policy groups
fail against that core (generic model refused and conflicting hint not refused),
which establishes the regression. Existing build/check-only CI run
[38802225292](https://github.com/bota-dev/app-sdk/actions/runs/38802225292)
produces the canonical correction on its pinned Linux GNU Rust 1.98.0 and
Binaryen 132.0.0 toolchain. The expected generation comparison fails because
the committed core is stale; this run is not a green qualification.

The retained diagnostics artifact `12005075606` has archive SHA-256
`44027fd7f2a37f884d517c6a31098ec09448f9611b0bc71fa4e1f1bd036283e3`.
All 106 exact source/generator inputs independently match that candidate; their
source SHA-256 is
`4763600c447609b1cd4554adb264c00a5a30bdda45a06c58fa6ffa98db441a39`.
The unmodified generated file is 3,968,489 bytes, SHA-256
`fe0a9725b7c4c6487f62c8ff7c58b0aed26a38fa966a1790dd893c7e0305ff2b`.
It is adopted byte-for-byte, and compiler-free provenance verification passes.
No generated implementation is handwritten and no local toolchain is downloaded.
The passing local checks above use this adopted core; isolated Node execution
does not establish pinned Hermes VM execution.

Current exact-main `9e7c54d8` qualification remains historical evidence for the
preceding core. No publication, app delivery, firmware installation or physical
settings acceptance is established by this source checkpoint.
