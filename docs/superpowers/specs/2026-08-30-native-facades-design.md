# Native Facades Design

- Status: Accepted
- Date: 2026-08-30
- Milestone: 3, Apple and Android native parity

## Purpose

Milestone 3 turns the deterministic Rust core into usable Apple and Android
App SDKs. Swift and Kotlin retain ownership of operating-system Bluetooth,
permissions, lifecycle, storage, and network integration. Rust remains the only
implementation of protocol parsing, serialization, and workflow decisions.

The work is complete only when both native packages pass the same conformance
traces and the physical-device P0 matrix. The existing native repositories stay
authoritative and available until that gate passes.

## Frozen Sources

The native scaffolds are pinned as migration inputs, not copied as completed
implementations:

| Platform | Repository revision | Verified baseline |
| --- | --- | --- |
| Apple | `cd15e545cabb8d6186dea93208b512a4f46cb5fd` | Swift package builds; 4 parser tests pass |
| Android | `0f06d2a22c55e4976778520cce42230d23ca4226` | Android library builds; unit tests pass |
| React Native behavior | `44ac1221cb71eb01cafcdbfdf7a370847d3a10b4` | 86 tests and 50 protocol fixtures |

The Apple and Android sources provide useful public models, async conventions,
and package scaffolding. Their Bluetooth transports, recording transfer, OTA,
recovery, and persistence are incomplete. React Native fixtures plus the Rust
workflow matrix remain the behavioral authority until native acceptance passes.

## Considered Approaches

### Selected: native transports over one typed C ABI

Move the authoritative Swift and Kotlin package shapes into this monorepo,
replace parser copies with the Rust core, and connect native host runtimes to a
manually owned versioned C ABI. Release builds contain prebuilt Rust libraries:
an XCFramework for Apple and per-ABI shared libraries inside the Android AAR.

This keeps CoreBluetooth and BluetoothGatt lifecycle code idiomatic, preserves
one workflow implementation, and does not require SDK consumers to install a
Rust toolchain.

### Rejected: keep three independent protocol implementations

Continuing the current React Native, Swift, and Kotlin implementations would
make reconnect, transfer, reset, and OTA fixes land three times. Fixture tests
reduce drift but do not eliminate state-machine divergence.

### Rejected: move Bluetooth into Rust

Rust Bluetooth wrappers would still need platform lifecycle, permission, state
restoration, and background-execution adapters. They would hide rather than
remove the platform-specific work and would make native failure diagnosis more
difficult.

### Rejected: build Rust in consumer applications

SwiftPM plugins and Gradle tasks can invoke Cargo, but that forces every
customer build environment to install and maintain Rust, cross targets, and an
NDK. Bota release CI builds and verifies native artifacts instead.

## Repository Layout

```text
bindings/
  device-sdk-ffi/           Shipping C ABI crate and public header
platforms/
  apple/                    Swift package, CoreBluetooth host, Apple tests
  android/                  Android library, JNI host, Android tests
tests/
  conformance/              Cross-facade deterministic host traces
  physical-device/          Operator-driven P0 acceptance harness
tools/
  build-apple/              Reproducible XCFramework assembly
  build-android/            Reproducible Android ABI assembly
release/
  evidence/                 Native build and physical-device evidence
```

The old native repositories are read-only migration sources after their pinned
revision. New implementation belongs in this monorepo.

## Shipping ABI

The shipping crate is `bota-device-sdk-ffi`. It builds `staticlib` and `cdylib`
artifacts and depends on `bota-device-sdk-core`. External C and Swift smoke
callers target this shipping crate; `tools/ffi-smoke` retains only the
feature-gated UniFFI comparison implementation.

### Versioning and symbols

- Every exported symbol begins with `bota_device_sdk_v1_`.
- `bota_device_sdk_v1_abi_version()` returns `1`.
- The header uses fixed-width integers, opaque handles, and explicit ownership.
- New optional packet kinds may be added within ABI v1; changing layout,
  ownership, or existing numeric values requires ABI v2.
- Enum discriminants and packet-field meanings are contract-tested.

### Typed packets

Commands, host events, effects, and notifications cross the ABI as a
`BotaDeviceSdkPacketV1` view. It contains:

- packet kind, operation, request ID, and 128-bit cancellation ID;
- an extensible borrowed list of fields with stable numeric field IDs;
- an explicit field type for unsigned, signed, Boolean, UTF-8, or raw bytes;
- scalar storage or a borrowed byte slice according to that field type.

Each packet kind defines exactly which field IDs and types are valid. Duplicate,
unknown, or mistyped input fields are rejected. Input slices are borrowed for a
call. Polled outputs are opaque owned packets whose views remain valid until
`bota_device_sdk_v1_packet_free`.

This interface has no JSON serialization. Recording packets, firmware chunks,
provisioning keys, grants, and characteristic values use raw byte slices.
Durable checkpoints are opaque core-owned bytes; native stores never interpret
their contents.

### Safety and errors

Every export catches Rust panics. Invalid pointers remain caller contract
violations documented in the header; malformed packet kinds, UTF-8, identifiers,
or field combinations return stable status values and a structured last error.
Each native bridge owns one engine handle and frees every output exactly once.

## Native Host Runtime

Each facade has a serial core actor that:

1. starts one typed command with explicit host capabilities;
2. polls all resulting effects;
3. performs native host work;
4. dispatches the completion event with the same request ID;
5. emits typed progress, discovery, log, completion, or error values;
6. propagates cancellation using the original 128-bit cancellation ID.

Effects are not executed recursively on Bluetooth callbacks. They enter one
ordered host queue, which prevents competing GATT operations and preserves the
core request order.

## Apple Facade

The Swift product and module are `BotaAppleSDK`; the public entry point is
`BotaDeviceClient`. It supports iOS 15 and macOS 13.

- `CoreBluetoothHost` owns one `CBCentralManager` on a dedicated serial queue.
- One radio arbiter prioritizes manual selection over background reconnect.
- One ordered operation queue exists per connected peripheral.
- Scanning also queries system-connected peripherals exposing Bota services so
  iOS-restored links do not disappear from pairing and reconnect flows.
- Connection success requires service discovery; discovery timeout tears down
  the half-open link before retry.
- Swift concurrency exposes `async` operations and `AsyncThrowingStream`
  progress/event streams.
- Durable checkpoints and reset receipts live in Application Support with
  atomic replace semantics. Secrets use Keychain when a workflow requests
  secure storage.
- URLSession performs application-authorized presigned transfers. Recording
  bytes stream through a native file sink and do not accumulate in memory.

Release CI assembles a checksum-addressed XCFramework. The Swift package wraps
that binary target; consumer builds do not invoke Cargo.

## Android Facade

The Maven coordinate is `dev.bota:device-sdk-android`; the public entry point is
`BotaDeviceClient`. It supports API 26 and compiles against the CI-pinned modern
Android SDK.

- `BluetoothGattHost` owns scan and connection callbacks on one HandlerThread.
- A coroutine radio arbiter prioritizes user work over reconnect.
- Each GATT connection serializes reads, writes, descriptor changes, service
  discovery, and MTU negotiation.
- The app owns runtime permission prompts; missing permission fails before any
  device mutation with a stable authorization error.
- Kotlin exposes `suspend` operations, `Flow`, and sealed errors.
- Atomic files store checkpoints and reset receipts. Android Keystore-backed
  storage serves secure-storage effects.
- OkHttp performs application-authorized presigned transfers from a native file
  sink without routing bytes through React Native or Flutter.

A thin JNI library translates Kotlin byte arrays and direct buffers to the C
ABI. The AAR contains Rust libraries for `arm64-v8a`, `armeabi-v7a`, `x86_64`,
and `x86` only while all four remain supported by the pinned Rust and NDK
toolchains; unsupported ABIs are removed explicitly from both package metadata
and documentation.

## Public Operations

Both facades expose equivalent semantics for:

- capability discovery;
- scan, manual connect, reconnect, disconnect, and connection observation;
- provisioning from application-provided material;
- device status and connection settings;
- recording list, resumable transfer to a native sink, and presigned upload;
- direct-upload ownership and Bluetooth fallback notification;
- firmware download, transfer progress, reboot, reconnect, and version readback;
- device log streaming;
- deprovision without data deletion;
- authenticated factory reset with durable result and receipt closure.

Public syntax is idiomatic per language. Parity means matching protocol bytes,
workflow decisions, stable errors, cancellation, and security behavior; it does
not require identical method names or impossible background capabilities.

## Testing and Release Gates

### Automated gates

- Rust ABI layout, ownership, malformed-input, panic, and packet-kind tests;
- external C caller compile/link/runtime smoke;
- Swift and Kotlin binding tests against the real native library;
- one deterministic fake-host trace suite executed through Rust, Swift, and
  Kotlin entry points;
- CoreBluetooth and BluetoothGatt adapter tests with scripted platform fakes;
- XCFramework import test in a clean sample package;
- AAR import and JNI runtime test in an emulator application;
- synchronized version, license, SBOM, checksum, and release-manifest checks.

### Physical-device P0 matrix

Apple and Android each pass on Bota Pin and Bota Note where the feature is
supported:

- scan and manual selection;
- reconnect by saved identity after app restart and device reboot;
- provisioning and serial verification;
- status, WiFi settings, and Note cellular normalization;
- recording list, interrupted transfer, resume, checksum, upload, and delete;
- direct WiFi upload ownership and safe BLE fallback;
- firmware download progress, transfer, reboot, reconnect, and version readback;
- log start, line delivery, cancel, and disconnect cleanup;
- remove-only deprovision;
- authenticated remove-and-reset receipt closure.

No native artifact is declared stable before both platform matrices pass. A
prerelease may identify missing physical rows explicitly, but it must not claim
those capabilities as supported.

## Delivery Order

1. Promote and freeze the typed shipping ABI.
2. Implement and package the Apple facade against fake-host conformance.
3. Implement and package the Android facade against the same traces.
4. Add physical-device automation and execute the P0 matrix.
5. Publish synchronized native prereleases.

Each stage lands on `main` only after its own tests pass. Existing SDKs remain
available throughout migration; application migration begins in Milestone 4.

## Non-Goals

- Migrating Demo or Bota One in this milestone.
- Adding backend API calls to the App SDK.
- Publishing React Native, Flutter, Web, or Windows facades.
- Retiring the old native or React Native repositories before stable acceptance.
- Changing firmware wire behavior as part of facade migration.
