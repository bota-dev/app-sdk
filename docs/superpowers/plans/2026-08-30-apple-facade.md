# Apple Device SDK Facade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a source-tested Apple facade that wraps native ABI v1 with idiomatic Swift concurrency, CoreBluetooth, durable host services, and a reproducible XCFramework.

**Architecture:** `BotaDeviceSDK` exposes Swift models and async managers while a single `CoreEngineActor` owns the opaque Rust engine. The actor drains typed ABI packets in order, an effect executor performs host work through narrow Swift protocols, and every completion returns the original operation, request, and cancellation identity. CoreBluetooth and storage remain native; protocol parsing and workflow decisions remain in Rust.

**Tech Stack:** Rust 1.98, C ABI v1, Swift 6, Swift Package Manager, CoreBluetooth, Security/Keychain, URLSession, XCTest, Xcode XCFramework tooling

**Spec:** `docs/superpowers/specs/2026-08-30-native-facades-design.md`

## Global Constraints

- Consume `bindings/device-sdk-ffi/include/bota_device_sdk.h` at the digest recorded in `release/evidence/1.0.0-alpha.1-native-abi.md`; do not redesign ABI v1.
- Preserve existing numeric symbol, packet-kind, field, capability, operation, status, and error meanings. ABI v1 changes are additive only.
- The new public package, product, and module are `BotaDeviceSDK`; the public entry point is `BotaDeviceClient`. The pinned Apple scaffold is a migration input, not a naming authority.
- Minimum platforms remain iOS 15 and macOS 13.
- Swift owns CoreBluetooth, application lifecycle, persistence, Keychain access, files, URLSession, and backend-material callbacks. Rust owns protocol codecs and deterministic workflows.
- One `CoreEngineActor` owns one engine handle. No C call for that handle runs outside the actor.
- Borrowed C inputs live through the complete call. Packet/error owners are copied to Swift values and freed exactly once before returning from the ABI client.
- Every host completion echoes the effect's operation, request ID, and cancellation ID.
- The Device SDK never calls the Bota API. Applications inject provisioning material, reset grants, firmware sources, and upload destinations.
- Recording and firmware payloads move between Rust and native files as bounded `Data` chunks; they never cross JavaScript or Dart in this milestone.
- No physical-device or published-package claim is made until the corresponding acceptance evidence exists.
- `BOTA_REACT_NATIVE_SDK_PATH` must point to a clean checkout of revision `44ac1221cb71eb01cafcdbfdf7a370847d3a10b4` when workflow parity runs.
- Every commit includes `Co-Authored-By: OpenAI Codex <noreply@openai.com>`.

---

### Task 1: Build The Apple XCFramework And Package Shell

**Files:**
- Create: `platforms/apple/Package.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/BotaDeviceSDK.swift`
- Create: `platforms/apple/Tests/BotaDeviceSDKTests/PackageSmokeTests.swift`
- Create: `tools/apple/build-xcframework.sh`
- Create: `tools/apple/test-package.sh`
- Modify: `.gitignore`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: crate `bota-device-sdk-ffi`, its public header, and Clang module `BotaDeviceSDKC`.
- Produces: `platforms/apple/Artifacts/BotaDeviceSDKCore.xcframework` and Swift package product `BotaDeviceSDK`.

- [ ] **Step 1: Write the failing package smoke test**

```swift
import XCTest
@testable import BotaDeviceSDK
import BotaDeviceSDKC

final class PackageSmokeTests: XCTestCase {
    func testPackageImportsFrozenAbi() {
        XCTAssertEqual(bota_device_sdk_v1_abi_version(), BOTA_DEVICE_SDK_ABI_VERSION)
        XCTAssertEqual(BotaDeviceSDKVersion.current, "1.0.0-alpha.1")
    }
}
```

- [ ] **Step 2: Run the package test and verify RED**

Run: `tools/apple/test-package.sh`

Expected: FAIL because the Apple artifact, package, and `BotaDeviceSDKVersion` do not exist.

- [ ] **Step 3: Implement reproducible slice assembly**

`build-xcframework.sh` must:

1. read the exact version from `sdk-version.toml`;
2. install and build `aarch64-apple-ios`, `aarch64-apple-ios-sim`,
   `x86_64-apple-ios`, `aarch64-apple-darwin`, and `x86_64-apple-darwin`;
3. combine simulator archives and macOS archives with `lipo`;
4. run `xcodebuild -create-xcframework` with the frozen public header directory;
5. replace `platforms/apple/Artifacts/BotaDeviceSDKCore.xcframework`
   atomically; and
6. reject a header digest that differs from the current native ABI evidence.

`Package.swift` defines a local binary target named `BotaDeviceSDKC`, a Swift
target and product named `BotaDeviceSDK`, iOS 15, macOS 13, and a test target. The
generated `Artifacts/` directory is ignored; release packaging later zips and
checksums it.

- [ ] **Step 4: Run the package and slice checks**

Run:

```bash
tools/apple/test-package.sh
xcrun lipo -info platforms/apple/Artifacts/BotaDeviceSDKCore.xcframework/ios-arm64_x86_64-simulator/libbota_device_sdk_ffi.a
xcodebuild -create-xcframework -help >/dev/null
```

Expected: the Swift test passes; simulator and macOS slices contain both
architectures; the device slice contains arm64.

- [ ] **Step 5: Commit**

```bash
git add .gitignore .github/workflows/ci.yml platforms/apple tools/apple
git commit -m "build(apple): assemble native core xcframework" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 2: Add A Memory-Safe Swift ABI Client

**Files:**
- Create: `platforms/apple/Sources/BotaDeviceSDK/Core/CoreField.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Core/CorePacket.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Core/CoreError.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Core/CoreAbiClient.swift`
- Test: `platforms/apple/Tests/BotaDeviceSDKTests/CoreAbiClientTests.swift`

**Interfaces:**
- Consumes: `bota_device_sdk_v1_engine_*`, packet/error view, protocol codec, and free functions.
- Produces: owned `CorePacket`, `CoreField`, `CoreError`, and internal `CoreAbiClient` operations.

```swift
enum CoreField: Equatable, Sendable {
    case unsigned(id: UInt32, value: UInt64)
    case signed(id: UInt32, value: Int64)
    case bool(id: UInt32, value: Bool)
    case text(id: UInt32, value: String)
    case bytes(id: UInt32, value: Data)
}

struct CorePacket: Equatable, Sendable {
    let kind: UInt32
    let operation: UInt32
    let requestID: UInt64
    let cancellationHigh: UInt64
    let cancellationLow: UInt64
    let fields: [CoreField]
}

struct CoreError: Error, Equatable, Sendable {
    let code: UInt32
    let operation: UInt32
    let retryable: Bool
    let protocolStatus: UInt16?
    let detail: String
}
```

- [ ] **Step 1: Write failing ownership and round-trip tests**

Tests cover all five field representations, empty slices, embedded zero bytes,
invalid UTF-8 rejection, structured error copying, one packet free, one error
free, and an engine handle that frees exactly once. A test ABI implementation
counts creates, views, and frees so ownership is asserted rather than inferred.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `tools/apple/test-package.sh --filter CoreAbiClientTests`

Expected: FAIL because the Swift ABI client types do not exist.

- [ ] **Step 3: Implement the ABI client**

Use a private `NativeEngineHandle` reference that owns one `OpaquePointer`.
Packet builders keep every `Data` and UTF-8 buffer alive inside nested
`withUnsafeBytes` calls through the complete C invocation. Output conversion
copies every field before a `defer` calls `bota_device_sdk_v1_packet_free`.
Error conversion follows the same pattern with `error_free`. Map negative C
status values to `CoreError`; `NO_OUTPUT` becomes `nil`, never an error.

- [ ] **Step 4: Run focused and standalone Swift tests**

Run:

```bash
tools/apple/test-package.sh --filter CoreAbiClientTests
tools/ffi-smoke/run-native-swift-smoke.sh
```

Expected: both pass with no leaks or double frees under Address Sanitizer on
the macOS test target.

- [ ] **Step 5: Commit**

```bash
git add platforms/apple/Sources/BotaDeviceSDK/Core platforms/apple/Tests/BotaDeviceSDKTests/CoreAbiClientTests.swift
git commit -m "feat(apple): wrap native abi ownership" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 3: Map Stable Swift Models, Errors, And Protocol Codecs

**Files:**
- Create: `platforms/apple/Sources/BotaDeviceSDK/Models/DeviceModels.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Models/RecordingModels.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Models/ConnectionModels.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Models/ProgressModels.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Models/BotaDeviceSDKError.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Core/CoreModelMapper.swift`
- Test: `platforms/apple/Tests/BotaDeviceSDKTests/ModelMappingTests.swift`
- Test: `platforms/apple/Tests/BotaDeviceSDKTests/ProtocolCodecTests.swift`

**Interfaces:**
- Consumes: `CorePacket`, shared protocol encode/decode ABI functions, pinned Apple public models, and language-neutral fixtures.
- Produces: public `DeviceStatus`, `DeviceRecording`, `TransferPacket`, `DeviceConnectionSettings`, `DiscoveredDevice`, `ConnectedDevice`, progress models, and `BotaDeviceSDKError`.

```swift
public struct BotaDeviceSDKError: Error, Equatable, Sendable {
    public let code: BotaDeviceSDKErrorCode
    public let operation: BotaOperation
    public let retryable: Bool
    public let protocolStatus: UInt16?
    public let detail: String
}

public enum WireValue<Known: Equatable & Sendable>: Equatable, Sendable {
    case known(Known)
    case unknown(UInt64)
}
```

- [ ] **Step 1: Write fixture-backed failing tests**

Load every applicable file under `protocol/fixtures/` as a SwiftPM test
resource. Assert that decoded Swift values preserve unknown enum numbers,
immediate-off `0`, always-on `-1`, Bota Note cellular normalization, recording
encryption metadata, transfer packet bytes, OTA status, WiFi result, and device
logs. Assert encoded bytes match every frozen expected hex value.

- [ ] **Step 2: Run tests and verify RED**

Run: `tools/apple/test-package.sh --filter ProtocolCodecTests`

Expected: FAIL because the model mapper and public model files do not exist.

- [ ] **Step 3: Implement model and codec mapping**

Port the useful public names and initializers from the pinned Apple baseline,
but remove its copied parser implementation. Every parse/serialize entry calls
`CoreAbiClient.protocolDecode` or `protocolEncode`. Use `WireValue.unknown` for
forward-compatible numeric states instead of collapsing them to legacy values.
Convert stable native errors without matching diagnostic strings.

- [ ] **Step 4: Run all model, codec, and Rust fixture tests**

Run:

```bash
tools/apple/test-package.sh --filter ModelMappingTests
tools/apple/test-package.sh --filter ProtocolCodecTests
cargo test -p bota-device-sdk-core --test fixture_decode --test fixture_encode --test model_contract --test round_trip
```

Expected: Swift and Rust agree on every committed fixture.

- [ ] **Step 5: Commit**

```bash
git add platforms/apple/Sources/BotaDeviceSDK/Models platforms/apple/Sources/BotaDeviceSDK/Core/CoreModelMapper.swift platforms/apple/Tests/BotaDeviceSDKTests
git commit -m "feat(apple): map shared models and codecs" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 4: Implement CoreEngineActor And Fake-Host Conformance

**Files:**
- Create: `platforms/apple/Sources/BotaDeviceSDK/Core/CoreCommand.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Core/CoreNotification.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Core/CoreEngineActor.swift`
- Create: `platforms/apple/Tests/BotaDeviceSDKTests/Support/FakeCoreHost.swift`
- Create: `platforms/apple/Tests/BotaDeviceSDKTests/CoreEngineActorTests.swift`
- Create: `platforms/apple/Tests/BotaDeviceSDKTests/WorkflowConformanceTests.swift`
- Create: `tools/apple/sync-workflow-fixtures.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: all 10 command kinds, 30 effect kinds, 34 host-event kinds, 12 notifications, and 29 canonical workflow scenarios.
- Produces: `CoreEngineActor.run`, `cancel`, internal correlated dispatch/drain behavior, and ordered `AsyncThrowingStream<CoreNotification, Error>`.

```swift
actor CoreEngineActor {
    init(abi: CoreAbiClient, host: CoreHost)
    func run(_ command: CoreCommand, capabilities: CoreCapabilities) -> AsyncThrowingStream<CoreNotification, Error>
    func cancel(_ id: UUID) async throws
}
```

- [ ] **Step 1: Generate fixtures and write failing actor tests**

The fixture sync tool derives a compact SwiftPM resource from all seven
`protocol/workflows/*.json` files and fails `--check` when stale. Tests assert
one active command, exact output ordering, monotonic request IDs, cancellation
scope, stale-event rejection without owner loss, and all 29 canonical traces.

- [ ] **Step 2: Run the actor tests and verify RED**

Run: `tools/apple/test-package.sh --filter CoreEngineActorTests`

Expected: FAIL because `CoreEngineActor` and the fixture resource do not exist.

- [ ] **Step 3: Implement one serialized engine loop**

`run` converts one command, calls start, drains all queued packets, yields
notifications, and executes effects one at a time through `CoreHost`. Each host
completion is dispatched before the next poll. The actor retains the active
cancellation ID until terminal notification. A second command is allowed to
reach Rust and returns stable `operationInProgress`; Swift does not invent a
parallel ownership policy.

- [ ] **Step 4: Run Swift and canonical workflow conformance**

Run:

```bash
node tools/apple/sync-workflow-fixtures.mjs --check
tools/apple/test-package.sh --filter WorkflowConformanceTests
npm run test:workflows -- --sdk-path "$BOTA_REACT_NATIVE_SDK_PATH"
```

Expected: 29 Swift traces and 29 Rust/React Native traces agree on ordered
effects, notifications, and terminal state.

- [ ] **Step 5: Commit**

```bash
git add package.json tools/apple platforms/apple/Sources/BotaDeviceSDK/Core platforms/apple/Tests/BotaDeviceSDKTests
git commit -m "feat(apple): drive workflows through core actor" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 5: Define Host Ports And The Effect Executor

**Files:**
- Create: `platforms/apple/Sources/BotaDeviceSDK/Host/CoreHost.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Host/BluetoothHost.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Host/PersistenceHost.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Host/NetworkHost.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Host/MaterialHost.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Host/RecordingSinkHost.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Host/FirmwareBlobHost.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Host/HostEffectExecutor.swift`
- Test: `platforms/apple/Tests/BotaDeviceSDKTests/HostEffectExecutorTests.swift`

**Interfaces:**
- Consumes: typed host-effect packets.
- Produces: exactly one matching host-event packet per completed request, except streaming BLE scan/notification callbacks which may produce ordered event sequences before their stop event.

```swift
protocol CoreHost: Sendable {
    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEvent, Error>
}

struct CoreHostEvent: Equatable, Sendable {
    let kind: UInt32
    let operation: UInt32
    let requestID: UInt64
    let cancellationHigh: UInt64
    let cancellationLow: UInt64
    let fields: [CoreField]
}
```

- [ ] **Step 1: Write exhaustive failing routing tests**

Build one typed effect for each of the 30 host-effect kinds. Assert routing to
the correct port, unchanged correlation identity, bounded raw bytes, streaming
termination, and stable failure event mapping. Include cancellation while a
port is suspended and an unrelated late completion.

- [ ] **Step 2: Run tests and verify RED**

Run: `tools/apple/test-package.sh --filter HostEffectExecutorTests`

Expected: FAIL because host ports and routing do not exist.

- [ ] **Step 3: Implement exhaustive effect routing**

Use an exhaustive Swift `switch` over internal `CoreEffect`. Do not use a
default branch. Timer tasks are keyed by request ID; persistence, material,
sink, blob, network, secure-storage, and BLE calls return the ABI event kind
defined for that result. Convert thrown host errors to the matching failed
event while retaining operation and cancellation identity.

- [ ] **Step 4: Run executor and ABI coverage tests**

Run:

```bash
tools/apple/test-package.sh --filter HostEffectExecutorTests
cargo test -p bota-device-sdk-ffi --test events --test outputs
```

Expected: all effect and callback variants are covered on both sides.

- [ ] **Step 5: Commit**

```bash
git add platforms/apple/Sources/BotaDeviceSDK/Host platforms/apple/Tests/BotaDeviceSDKTests/HostEffectExecutorTests.swift
git commit -m "feat(apple): execute correlated host effects" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 6: Serialize CoreBluetooth Operations

**Files:**
- Create: `platforms/apple/Sources/BotaDeviceSDK/Bluetooth/BluetoothUUIDs.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Bluetooth/CentralDriver.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Bluetooth/CoreBluetoothDriver.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Bluetooth/CoreBluetoothHost.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Bluetooth/RadioArbiter.swift`
- Test: `platforms/apple/Tests/BotaDeviceSDKTests/Support/FakeCentralDriver.swift`
- Test: `platforms/apple/Tests/BotaDeviceSDKTests/CoreBluetoothHostTests.swift`

**Interfaces:**
- Consumes: BLE start/stop scan, connect, discover, disconnect, read, write, subscribe, and unsubscribe effects.
- Produces: correlated BLE result events and unsolicited notification events; never exposes `CBPeripheral` outside the Bluetooth layer.

- [ ] **Step 1: Write failing operation-order tests**

Tests prove scan deduplication respects `allowDuplicates`; the same peripheral
serializes connect, discovery, subscribe, read, and write; different
peripherals may progress independently; service discovery precedes
characteristic lookup; system-connected peripherals exposing a Bota service are
merged into scan results; manual selection preempts background reconnect; a
service-discovery timeout tears down the half-open link; a disconnect fails all
pending operations once; and a late delegate callback cannot complete a newer
request.

- [ ] **Step 2: Run tests and verify RED**

Run: `tools/apple/test-package.sh --filter CoreBluetoothHostTests`

Expected: FAIL because the CoreBluetooth adapter does not exist.

- [ ] **Step 3: Implement the driver and actor host**

Keep `CBCentralManagerDelegate` and `CBPeripheralDelegate` in a driver created
with one dedicated serial `DispatchQueue`. Send value-only callback records
into `CoreBluetoothHost`, which is an actor. Key pending work by peripheral ID
plus operation type and request ID. `RadioArbiter` grants one radio owner and
always lets manual selection cancel or defer background reconnect. Query
`retrieveConnectedPeripherals(withServices:)` when a scan starts, and merge
those peripherals with advertisements by UUID. Retain peripherals only while
needed. Read manufacturer data and advertised service UUIDs without treating
the display name as identity. Connection completion is emitted only after Bota
services and characteristics are discovered.

- [ ] **Step 4: Run tests and compile both Apple platforms**

Run:

```bash
tools/apple/test-package.sh --filter CoreBluetoothHostTests
(cd platforms/apple && xcodebuild -scheme BotaDeviceSDK -destination 'generic/platform=iOS' build CODE_SIGNING_ALLOWED=NO)
swift build --package-path platforms/apple
```

Expected: operation tests pass, the iOS target compiles, and the macOS package
builds.

- [ ] **Step 5: Commit**

```bash
git add platforms/apple/Sources/BotaDeviceSDK/Bluetooth platforms/apple/Tests/BotaDeviceSDKTests
git commit -m "feat(apple): add serialized corebluetooth host" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 7: Implement Durable Storage, Network, And Material Hosts

**Files:**
- Create: `platforms/apple/Sources/BotaDeviceSDK/Host/FilePersistenceHost.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Host/KeychainSecureStorageHost.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Host/FileRecordingSinkHost.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Host/FileFirmwareBlobHost.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Host/URLSessionNetworkHost.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/Host/ApplicationMaterialHost.swift`
- Test: `platforms/apple/Tests/BotaDeviceSDKTests/DurableHostTests.swift`
- Test: `platforms/apple/Tests/BotaDeviceSDKTests/NetworkHostTests.swift`

**Interfaces:**
- Consumes: opaque checkpoint, sink, blob, material, destination, and download IDs.
- Produces: atomic checkpoint/reset journals, Keychain values, bounded file chunks, finalized recording hashes, URLSession progress, and application-supplied secrets/grants.

- [ ] **Step 1: Write failing durability and isolation tests**

Use temporary directories and an injected `URLProtocol`. Assert atomic replace,
load after host recreation, exact factory-reset result retention, delete only
after receipt, sink append/finalize order, SHA-256 mismatch failure, bounded
firmware reads, HTTP cancellation, progress monotonicity, and no URL/token/path
inside persisted core checkpoints.

- [ ] **Step 2: Run tests and verify RED**

Run: `tools/apple/test-package.sh --filter DurableHostTests`

Expected: FAIL because concrete host services do not exist.

- [ ] **Step 3: Implement native host services**

Store non-secret journals under Application Support with data-protection
attributes and atomic replacement. Store device secrets in a dedicated
Keychain service. Restrict sink/blob IDs to generated UUID keys, never paths.
Use `FileHandle` for bounded chunks and CryptoKit SHA-256 for final integrity.
Use URLSession delegates for streamed upload/download progress. Resolve
provisioning/reset material only through application closures registered by
opaque ID; never construct Bota API requests.

- [ ] **Step 4: Run host and security checks**

Run:

```bash
tools/apple/test-package.sh --filter DurableHostTests
tools/apple/test-package.sh --filter NetworkHostTests
rg -n "Authorization|dtok_|sk_live_|sk_test_|presigned" platforms/apple/Sources
```

Expected: tests pass; the search finds no embedded credential or backend client.

- [ ] **Step 5: Commit**

```bash
git add platforms/apple/Sources/BotaDeviceSDK/Host platforms/apple/Tests/BotaDeviceSDKTests
git commit -m "feat(apple): add durable native host services" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 8: Expose Discovery, Connection, And Reconnect

**Files:**
- Create: `platforms/apple/Sources/BotaDeviceSDK/BotaDeviceClient.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/DeviceManager.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/BotaConfiguration.swift`
- Test: `platforms/apple/Tests/BotaDeviceSDKTests/DeviceManagerTests.swift`

**Interfaces:**
- Consumes: discovery, connect, and reconnect core commands plus injected hosts.
- Produces: public `BotaDeviceClient`, `DeviceManager.startScan`, `capabilities`, `connect`, `reconnect`, `disconnect`, connection observation, and status streams.

```swift
public final class BotaDeviceClient: @unchecked Sendable {
    public static let shared = BotaDeviceClient()
    public let devices: DeviceManager
    public let recordings: RecordingManager
    public let ota: OTAManager
    public let logs: DeviceLogManager
    public func configure(_ configuration: BotaConfiguration = .init()) async throws
    public func destroy() async
}
```

- [ ] **Step 1: Write failing public-flow tests**

Assert configure is required once, Bluetooth authorization errors are stable,
capability discovery reports the host contract, scan and connection observation
stream values, manual connect always verifies serial identity,
reconnect prefers exact saved peripheral ID or advertised address, fallback
probes candidates sequentially, one device connects at a time, cancellation
stops scanning, and destroy releases all streams and the engine.

- [ ] **Step 2: Run tests and verify RED**

Run: `tools/apple/test-package.sh --filter DeviceManagerTests`

Expected: FAIL because the public client and manager do not exist.

- [ ] **Step 3: Implement the public connection facade**

Keep public models value-only and `Sendable`. `DeviceManager` builds typed core
commands and translates terminal notifications into async return values. It
never selects by name and never creates its own reconnect policy. Persist only
the exact identity requested by the core effect. Status reads use the shared
protocol decoder.

- [ ] **Step 4: Run focused and connection conformance tests**

Run:

```bash
tools/apple/test-package.sh --filter DeviceManagerTests
cargo test -p bota-device-sdk-core --test connection_workflow
```

Expected: Swift public behavior follows the canonical connection reducer.

- [ ] **Step 5: Commit**

```bash
git add platforms/apple/Sources/BotaDeviceSDK platforms/apple/Tests/BotaDeviceSDKTests/DeviceManagerTests.swift
git commit -m "feat(apple): expose connection workflows" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 9: Expose Provisioning, Settings, And Authenticated Reset

**Files:**
- Create: `platforms/apple/Sources/BotaDeviceSDK/ProvisioningManager.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/FactoryResetManager.swift`
- Test: `platforms/apple/Tests/BotaDeviceSDKTests/ProvisioningManagerTests.swift`
- Test: `platforms/apple/Tests/BotaDeviceSDKTests/FactoryResetManagerTests.swift`

**Interfaces:**
- Consumes: opaque material IDs, application material callbacks, provisioning and reset workflows, and connection-settings codec.
- Produces: `provision`, `writeConnectionSettings`, `deprovision`, `factoryReset`, and `resumePendingFactoryReset`.

- [ ] **Step 1: Write failing security-flow tests**

Assert nonce and device key are read before material resolution; subscription
precedes grant writes; oversize chunks fail before BLE mutation; Bota Note
settings remove cellular; unbind/deprovision never invokes reset; reset persists
the exact success before receipt; restart resumes receipt only; and a stale
binding generation cannot close a newer reset command.

- [ ] **Step 2: Run tests and verify RED**

Run: `tools/apple/test-package.sh --filter FactoryResetManagerTests`

Expected: FAIL because the managers do not exist.

- [ ] **Step 3: Implement the public provisioning and reset facade**

Accept application-supplied opaque IDs and callback providers. Keep tokens,
keys, grants, and endpoints inside the material host and bounded C input calls.
Expose deprovision and factory reset as separate methods. On startup, load the
durable reset result and run only `resumePendingFactoryReset`; never resend the
destructive command from a receipt retry.

- [ ] **Step 4: Run focused and Rust security workflows**

Run:

```bash
tools/apple/test-package.sh --filter ProvisioningManagerTests
tools/apple/test-package.sh --filter FactoryResetManagerTests
cargo test -p bota-device-sdk-core --test provisioning_workflow --test factory_reset_workflow
```

Expected: ordering and restart behavior match the shared core.

- [ ] **Step 5: Commit**

```bash
git add platforms/apple/Sources/BotaDeviceSDK platforms/apple/Tests/BotaDeviceSDKTests
git commit -m "feat(apple): expose secure device lifecycle" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 10: Expose Recording, Upload, OTA, And Device Logs

**Files:**
- Create: `platforms/apple/Sources/BotaDeviceSDK/RecordingManager.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/OTAManager.swift`
- Create: `platforms/apple/Sources/BotaDeviceSDK/DeviceLogManager.swift`
- Test: `platforms/apple/Tests/BotaDeviceSDKTests/RecordingManagerTests.swift`
- Test: `platforms/apple/Tests/BotaDeviceSDKTests/OTAManagerTests.swift`
- Test: `platforms/apple/Tests/BotaDeviceSDKTests/DeviceLogManagerTests.swift`

**Interfaces:**
- Consumes: recording transfer, upload handoff, firmware update, and device-log workflows plus file/network hosts.
- Produces: recording list/sync streams, direct-upload ownership results, OTA download/transfer progress, and sanitized device-log lines.

- [ ] **Step 1: Write failing workflow tests**

Recording tests cover durable append before ACK, replay deduplication, checksum
failure without delete, final ACK before confirm, encrypted bytes remaining
opaque, and direct-upload fallback only after fresh inactive status. OTA tests
cover download progress, rejection before blob reads, eight-packet windows,
resume from device offset zero, expected reboot, reconnect, and target-version
readback. Log tests cover subscribe-before-start, split UTF-8, sequence gaps,
single ownership, stop-before-unsubscribe, and disconnect cleanup without stop.

- [ ] **Step 2: Run tests and verify RED**

Run: `tools/apple/test-package.sh --filter RecordingManagerTests`

Expected: FAIL because the managers do not exist.

- [ ] **Step 3: Implement manager streams**

Managers translate core progress notifications directly into typed
`AsyncThrowingStream` values. The recording sink and firmware blob remain
native files. Direct upload consumes an application-registered destination;
busy, detached, or unreadable ownership never starts BLE fallback. OTA reuses
the downloaded blob while the reducer restarts device delivery at zero. Device
logs yield only complete sanitized lines from the core notification.

- [ ] **Step 4: Run all workflow tests**

Run:

```bash
tools/apple/test-package.sh --filter RecordingManagerTests
tools/apple/test-package.sh --filter OTAManagerTests
tools/apple/test-package.sh --filter DeviceLogManagerTests
cargo test -p bota-device-sdk-core --test recording_transfer_workflow --test upload_handoff_workflow --test firmware_update_workflow --test device_logs_workflow
```

Expected: all four workflow families match their canonical reducers.

- [ ] **Step 5: Commit**

```bash
git add platforms/apple/Sources/BotaDeviceSDK platforms/apple/Tests/BotaDeviceSDKTests
git commit -m "feat(apple): expose transfer ota and logs" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 11: Add Consumer Import And Apple CI Gates

**Files:**
- Create: `tests/conformance/apple-consumer/Package.swift`
- Create: `tests/conformance/apple-consumer/Sources/AppleConsumer/main.swift`
- Create: `tools/apple/test-consumer.sh`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/releasing.md`

**Interfaces:**
- Consumes: local `BotaDeviceSDK` package and generated XCFramework.
- Produces: an external consumer compile/run gate on macOS plus generic iOS compilation.

- [ ] **Step 1: Write a failing external consumer**

The executable imports only public `BotaDeviceSDK`, constructs `BotaConfiguration`,
checks `BotaDeviceSDKVersion.current`, and type-checks calls to scan, reconnect,
recording sync, OTA, logs, deprovision, and factory reset. It must not import the
internal C module.

- [ ] **Step 2: Run the consumer and verify RED**

Run: `tools/apple/test-consumer.sh`

Expected: FAIL until all public managers are exported by the package.

- [ ] **Step 3: Add release-grade CI jobs**

On a pinned macOS runner, build the XCFramework, run `swift test` with strict
concurrency diagnostics, run the external consumer, compile generic iOS device
and simulator destinations, archive the XCFramework zip, calculate SwiftPM
checksum, and upload both as non-published CI artifacts. Keep code signing off
for CI compilation.

- [ ] **Step 4: Run the complete source and consumer gate**

Run:

```bash
tools/apple/test-package.sh
tools/apple/test-consumer.sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
```

Expected: the package and an unrelated consumer compile without local source
imports or unsafe linker flags.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml tests/conformance/apple-consumer tools/apple README.md ARCHITECTURE.md docs/releasing.md
git commit -m "test(apple): verify package consumption" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 12: Package Checksums, License, SBOM, And Release Manifest

**Files:**
- Create: `tools/apple/package-release.sh`
- Create: `tools/release/generate-apple-sbom.mjs`
- Create: `tools/release/generate-apple-sbom.test.mjs`
- Create: `tools/release/generate-apple-manifest.mjs`
- Create: `tools/release/generate-apple-manifest.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/releasing.md`

**Interfaces:**
- Consumes: the tested XCFramework, `sdk-version.toml`, Cargo and Swift package metadata, protocol fixture digest, firmware matrix, source revision, and root `LICENSE`.
- Produces: `BotaDeviceSDKCore.xcframework.zip`, SHA-256 and SwiftPM checksums, SPDX 2.3 JSON, copied license, and a schema-valid Apple artifact entry.

- [ ] **Step 1: Write failing release-metadata tests**

Tests assert the SPDX document names the synchronized SDK version, includes the
Rust core/FFI dependency relationship and Swift package, contains no local
paths, and references the XCFramework checksum. Manifest tests assert ecosystem
`swiftpm`, exact version/source revision, unique capability names, real artifact
checksum, frozen fixture digest, and firmware baseline revision.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tools/release/generate-apple-*.test.mjs`

Expected: FAIL because the Apple release generators do not exist.

- [ ] **Step 3: Implement deterministic release packaging**

`package-release.sh` rebuilds the XCFramework, normalizes zip entry timestamps,
copies `LICENSE`, writes SHA-256 and `swift package compute-checksum` values,
and invokes the two Node generators. The SBOM generator consumes only `cargo
metadata --locked --format-version 1` and `swift package show-dependencies
--format json`. The manifest generator emits an Apple artifact with only the
capabilities proven in the compatibility matrix, then runs `cargo xtask release
validate` on the result. It refuses a dirty source tree or zero checksum.

- [ ] **Step 4: Run packaging and validate every output**

Run:

```bash
node --test tools/release/generate-apple-*.test.mjs
tools/apple/package-release.sh
cargo xtask release validate target/apple-release/release-manifest.json
swift package compute-checksum target/apple-release/BotaDeviceSDKCore.xcframework.zip
```

Expected: generated checksums agree, the license and SPDX document are present,
and the release manifest validates.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml tools/apple tools/release docs/releasing.md
git commit -m "build(apple): generate release metadata" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 13: Add Physical-Device Harness And Freeze Apple Evidence

**Files:**
- Create: `platforms/apple/Tests/BotaDeviceSDKPhysicalTests/PhysicalDeviceTests.swift`
- Create: `platforms/apple/Tests/BotaDeviceSDKPhysicalTests/PhysicalTestConfiguration.swift`
- Create: `docs/testing/apple-physical-device.md`
- Create: `release/evidence/1.0.0-alpha.1-apple-facade.md`
- Modify: `protocol/compatibility/firmware-compatibility.json`
- Modify: `protocol/baseline/native-sdks.json`
- Modify: `docs/releasing.md`

**Interfaces:**
- Consumes: Bota Pin and Bota Note lab devices explicitly selected by serial number, plus the application callbacks required for provisioning, upload, and reset.
- Produces: auditable Apple acceptance evidence; it does not run against an arbitrary nearby device.

- [ ] **Step 1: Write opt-in physical tests**

Require `BOTA_PHYSICAL_TESTS=1`, `BOTA_DEVICE_SERIAL`, and
`BOTA_DEVICE_MODEL`. Skip otherwise. Run the matrix once for Bota Pin and once
for Bota Note, skipping only features the compatibility matrix marks
unsupported for that model. The suite covers permission state, scan visibility, serial-verified pairing,
reconnect after device reboot and OTA, provisioning, status/settings, recording
list and transfer, direct upload ownership, OTA progress and readback, device
logs, deprovision, and authenticated reset receipt. Destructive reset also
requires `BOTA_ALLOW_FACTORY_RESET=1` and a command-bound test grant.

- [ ] **Step 2: Prove the default gate is non-destructive**

Run: `tools/apple/test-package.sh`

Expected: the physical suite reports skipped tests without opening Bluetooth or
changing a device.

- [ ] **Step 3: Run the supervised lab matrix**

Run:

```bash
BOTA_PHYSICAL_TESTS=1 \
BOTA_DEVICE_SERIAL="$BOTA_DEVICE_SERIAL" \
BOTA_DEVICE_MODEL="$BOTA_DEVICE_MODEL" \
tools/apple/test-package.sh --filter PhysicalDeviceTests
```

Run authenticated reset separately only with the documented backend grant and
`BOTA_ALLOW_FACTORY_RESET=1`. Record device model, firmware revision, Apple OS,
hardware type, test revision, and each result in the evidence file.

- [ ] **Step 4: Update capability status only from evidence**

Set the Apple facade status in the compatibility matrix to
`physical_device_verified` only when every required non-destructive case passes
and the separately gated reset case has an exact receipt. Keep unsupported or
unrun capabilities explicit. Update the native baseline from scaffold authority
to the monorepo revision containing the accepted facade.

- [ ] **Step 5: Run the final Apple release gate and commit**

Run:

```bash
npm ci
npm run check
npm run test:tooling
npm run test:workflows -- --sdk-path "$BOTA_REACT_NATIVE_SDK_PATH"
cargo xtask protocol generate --check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
tools/ffi-smoke/run-native-c-smoke.sh
tools/ffi-smoke/run-native-swift-smoke.sh
tools/apple/test-package.sh
tools/apple/test-consumer.sh
cargo deny check
```

Expected: every automated gate passes and the evidence distinguishes automated,
simulator, generic-device compile, and supervised physical-device results.

```bash
git add platforms/apple docs/testing release/evidence docs/releasing.md protocol
git commit -m "docs(apple): record facade acceptance evidence" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

## Exit Criteria

- The Swift package imports from an unrelated consumer and supports iOS 15 and macOS 13.
- The XCFramework contains arm64 iOS, arm64/x86_64 simulator, and arm64/x86_64 macOS slices built from the frozen ABI.
- Swift tests cover all ABI packet categories, all 30 effects, all 34 events, and all 29 canonical workflows.
- CoreBluetooth operations are serialized and correlated without name-based identity.
- Checkpoint, reset journal, Keychain, sink, blob, URLSession, and material hosts pass restart and cancellation tests.
- The Apple archive includes the reviewed license, matching SHA-256 and SwiftPM checksums, SPDX 2.3 SBOM, and validated release manifest.
- The physical-device matrix records pairing, reconnect, provisioning, transfer, upload ownership, OTA, logs, deprovision, and authenticated reset.
- No Apple package is marked publishable before its evidence, checksum, and capability manifest are reviewed.
