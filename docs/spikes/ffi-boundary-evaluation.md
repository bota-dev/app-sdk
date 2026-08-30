# Native FFI Boundary Evaluation

- Status: Decided for the first native facade milestone
- Date: 2026-08-30
- Selected boundary: manually owned C ABI
- Compared generator: UniFFI `0.32.0`

## Scope

This spike chooses how native facades call the deterministic Rust workflow
engine. It does not ship an Apple, Android, Windows, React Native, or Flutter
artifact, and its JSON command/event envelope is test scaffolding rather than a
promise that every production call will use JSON.

Both candidates drive the same `WorkflowEngine` and passed the same discovery,
event-correlation, cancellation, output-polling, and error-delivery smoke
contract. The production React Native SDK remains authoritative until native
facades pass their own application and physical-device gates.

## Decision

Use a small, manually reviewed C ABI between Rust and native facades.

- The ABI exposes opaque engine handles, numeric request and cancellation IDs,
  borrowed input spans, SDK-owned output buffers, and an explicit buffer-free
  function.
- Rust never exposes its struct layout, `Vec`, `String`, futures, or an async
  runtime across the boundary.
- Swift calls the C module directly. Android owns a thin JNI adapter. Windows
  uses C/C++ or .NET P/Invoke. Flutter uses Dart FFI. React Native delegates to
  the Apple and Android facades.
- Web remains a TypeScript/Web Bluetooth facade; neither candidate makes a
  native library available to a browser.
- Large recording and firmware buffers stay between Rust and native host
  effects. They do not cross JavaScript or Dart as JSON or generated strings.

UniFFI remains a non-published comparison spike only. It is not a dependency of
`bota-device-sdk-core` and is not part of a shipping artifact.

## Why

The pinned [UniFFI bindings documentation](https://mozilla.github.io/uniffi-rs/latest/bindings.html)
and generator provide first-party Swift and Kotlin output. The `0.32.0` CLI in
this spike also lists Python and Ruby, but not C# or Dart. Third-party bindings
were not accepted as the foundation of Bota's cross-platform ABI.

The generated Swift and Kotlin APIs are convenient, especially for object
lifetime and error conversion. That convenience does not remove Bota's native
transport work: BLE permissions, lifecycle, background execution, secure
storage, and large-buffer ownership still require platform adapters. A stable
C surface gives those adapters one boundary across all target languages and
keeps generator internals out of the public SDK contract.

## Measured Results

Measurements used Rust `1.98.0` on arm64 macOS with the default release profile.
The manual and generated candidates were compiled from the same smoke crate;
the UniFFI generator CLI was separated from the runtime graph before measuring.

| Measure | Manual C ABI | UniFFI `0.32.0` |
| --- | ---: | ---: |
| Release `cdylib` | 1,028,432 bytes | 1,158,464 bytes |
| Size increase from generator runtime | - | 130,032 bytes (12.6%) |
| Unique normal dependency-tree entries | 15 | 56 |
| Reviewed/generated interface source | 97-line C header | 2,917 generated lines |
| Interface source bytes | 3,134 | 114,679 |
| Separate non-shipping generator graph | none | 92 entries |

The generated-source result consists of 835 Swift lines, 578 Swift C-header
lines, a 6-line module map, and 1,498 Kotlin lines. Swift output compiled,
linked the generated bridge to the Rust dynamic library, and exercised both a
workflow call and generated error conversion with Apple Swift `6.3.3`. Kotlin
output was generated deterministically; this machine had no Kotlin compiler,
Android SDK, or NDK, so Android compilation and final per-ABI size remain
facade-milestone gates rather than claims from this spike. The same applies to
iOS device, Windows, Dart, and packaged-framework sizes.

The manual header passed C11 and C++17 syntax checks. A standalone C11 client
also linked the produced dynamic library and exercised create, start, poll,
cancel, error retrieval, buffer free, and engine free. Both Rust smoke paths
passed under the pinned repository toolchain.

## Call Surfaces

The manual Swift facade owns the explicit lifetime and buffer release:

```swift
let engine = bota_device_sdk_engine_new()
defer { bota_device_sdk_engine_free(engine) }

let status = command.withUnsafeBytes { bytes in
    bota_device_sdk_engine_start_json(
        engine, bytes.baseAddress, bytes.count, capabilities, 0, cancelID)
}

var output = BotaDeviceSdkOwnedBuffer()
if status == BOTA_DEVICE_SDK_OK,
   bota_device_sdk_engine_poll_output(engine, &output) == BOTA_DEVICE_SDK_OK {
    defer { bota_device_sdk_buffer_free(output) }
    // Decode the correlated effect and execute it on the native host.
}
```

Android presents an idiomatic Kotlin facade while a small JNI layer owns the C
handle and copies or borrows buffers according to the header contract:

```kotlin
val engine = NativeWorkflowEngine.create()
try {
    engine.start(commandJson, capabilities, cancellationId)
    engine.pollOutput()?.let(host::executeEffect)
} finally {
    engine.close()
}
```

For comparison, UniFFI generated this direct shape:

```swift
let engine = UniFfiEngine()
try engine.startJson(
    commandJson: command,
    capabilityBits: capabilities,
    cancellationIdHigh: 0,
    cancellationIdLow: cancelID)
let output = engine.pollOutput()
```

```kotlin
UniFfiEngine().use { engine ->
    engine.startJson(command, capabilities, 0uL, cancelId)
    val output = engine.pollOutput()
}
```

## Cancellation And Events

The core is a synchronous reducer, not an async executor. Starting a command or
dispatching a host event returns zero or more correlated effects immediately.
The native host performs BLE, timer, persistence, and network work, then echoes
the effect's numeric request ID in the next event. Cancellation uses the same
path with a 128-bit cancellation identity.

This behavior is identical through both candidates. UniFFI async bindings
would not reduce host lifecycle work and could obscure which side owns an OS
operation. The selected C ABI therefore keeps polling and dispatch explicit.
Facades may offer native `async`/coroutine APIs above it while retaining the
same IDs and cancellation rules.

## Copies And Ownership

The spike copies caller command/event bytes before parsing. Manual outputs move
one Rust allocation across the ABI and are released by
`bota_device_sdk_buffer_free`; a facade then decodes or copies them into its
native representation. UniFFI lowers and lifts `String` through generated
Rust-buffer conversion, also requiring allocation and string decoding.

This comparison is intentionally metadata-sized. Production recording chunks,
firmware chunks, secrets, file paths, and upload credentials remain host-owned
or use bounded native buffer views. They must not be routed through this JSON
envelope.

## License And Reproducibility

UniFFI `0.32.0` is MPL-2.0. Exact package-specific exceptions are recorded in
`deny.toml` for the non-shipping spike crates; MPL-2.0 was not added to the
repository-wide allow list. `cargo deny check` passes.

The repository pins Rust `1.98.0`, locks dependencies in `Cargo.lock`, and pins
UniFFI exactly to `0.32.0`. Linux CI compiles and runs the standalone C client,
runs both Rust smoke paths, and regenerates Swift and Kotlin output with
formatting disabled. macOS CI compiles and runs the generated Swift binding.
Generated files are evidence under `target/` and are not committed or
published.

## Verification Commands

```bash
cargo test -p bota-device-sdk-core --test ffi_contract
cargo test -p bota-device-sdk-ffi-smoke --features uniffi-spike --all-targets
tools/ffi-smoke/run-c-smoke.sh
tools/ffi-smoke/run-uniffi-swift-smoke.sh
cargo build --release -p bota-device-sdk-ffi-smoke --no-default-features
cargo build --release -p bota-device-sdk-ffi-smoke --features uniffi-spike
cargo run -p bota-device-sdk-uniffi-bindgen -- generate --no-format \
  --library --language swift --language kotlin --out-dir target/ffi-smoke \
  target/debug/libbota_device_sdk_ffi_smoke.dylib
cargo deny check
```

## Follow-Up Gates

Before any native facade is published:

1. Replace spike JSON where typed or buffer-oriented calls materially reduce
   allocation or schema risk.
2. Freeze and version the exported C symbols and wire representations.
3. Compile and test Apple device/simulator slices, Android ABIs, and Windows
   targets; record stripped and packaged size deltas for each.
4. Run Swift, Kotlin/JNI, Dart FFI, and .NET ownership and cancellation tests.
5. Pass application and physical-device parity before switching Demo or Bota
   One away from the production React Native SDK.
