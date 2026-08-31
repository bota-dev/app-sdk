# Bota App SDK

Source monorepo for the **Bota App SDK** family. The repository will provide
a shared Rust protocol and workflow core with platform-native Bluetooth
transports and idiomatic Apple, Android, React Native, Flutter, Web, and Windows
facades.

The existing `@bota.dev/react-native-sdk` remains the supported production SDK
until the replacement passes protocol, workflow, native, application, and
physical-device parity gates.

## Current Status

The App SDK is preparing synchronized native release `1.1.0`: the repository has a generated
protocol manifest, 50 language-neutral compatibility fixtures, bounded Rust
decoders, byte-exact serializers, stable models/errors, and deterministic
discovery, connection-recovery, provisioning, authenticated-reset, resumable
recording-transfer, guarded upload-handoff, and resumable firmware-update
reducers, plus exclusive device-log subscription ownership and line delivery.
Twenty-nine canonical workflow scenarios are schema validated, pinned to the
React Native `0.0.65` baseline, and backed by 25 executable Rust tests covering
positive, rejection, cancellation, and resume or restart-recovery behavior.
The same pinned SDK now has a semantic TypeScript compatibility contract for
all 80 root exports, expanded type aliases, static factories, and reachable
public members; future React Native packages must match that digest in addition
to the protocol and workflow gates. A private `frameworks/react-native`
foundation now pins the apps' React Native 0.86.3 New Architecture floor,
validates a low-volume lifecycle, device-connection, device-status,
nonce-bound provisioning, authenticated-reset, native-file recording transfer,
guarded upload ownership, and native-download OTA TurboModule contract for iOS
and Android, and
rejects Codegen drift or bridge fields that could carry recording or firmware
bytes. Its Apple lifecycle adapter now serializes configuration and destruction
through `BotaAppleSDK`; its device adapter owns discovery/status subscriptions
and delegates selected connect, serial-strict reconnect, disconnect, and status
reads. Its one-shot material broker delegates provisioning, remove-only
deprovision, authenticated reset, and receipt-only reset recovery without
reopening the nonce race. The reset grant crosses JavaScript as an encoded
application value and becomes bytes only inside the native adapter. A
disposable CocoaPods application proves that the generated TurboModule, typed event emitter,
Objective-C++, Swift, Swift Package, and Rust XCFramework layers compile and
link together. Its Android adapters provide the same lifecycle, connection,
status, provisioning, authenticated-reset, recording-transfer, upload
ownership, and OTA slices through `BotaDeviceClient.shared`; a
checked-in React Native Gradle consumer runs Codegen, Kotlin tests, lint, and
release assembly against the exact locally packaged AAR. The package now
matches 75 of the 80 frozen `0.0.65` root exports: every public type plus the
pure errors, sync-status derivation, and device-log decoder. It is not an
installable replacement yet: the five native workflow classes (`BotaClient`,
`DeviceManager`, `RecordingManager`, `StreamingSession`, and `OTAManager`), app
acceptance, and npm publication remain open.
The Android package foundation now pins JDK 17, Gradle 8.13, Android Gradle
Plugin 8.13.2, Kotlin 2.1.20, API 26/36, NDK 28.2.13676358, and CMake 3.22.1.
It produces a version-synchronized, unsigned local AAR with sources, Dokka
Javadocs, POM, and Gradle metadata. The AAR now packages the frozen Rust ABI and
thin JNI ownership adapter for four Android ABIs; real API 35 instrumentation
proves typed codec calls, workflow polling, and exact-once native ownership.
Immutable public Kotlin models now map all 50 canonical protocol fixtures
through the Rust codec, preserve unknown wire values, normalize Bota Note
settings, and expose stable machine-readable errors. A single-thread coroutine
runtime now owns every Android JNI call, preserves 128-bit cancellation and
host callback correlation, and maps all 10 commands, 30 effects, 34 events,
and 12 notifications. API 35 instrumentation validates the generated resource
covering all 29 canonical workflow scenarios. Its exhaustive host executor
routes every effect through a narrow typed native port, validates callback
kinds and payload bounds, and preserves correlation while mapping platform
failures to stable ABI events. The Android BluetoothGatt host now keeps
framework objects on one HandlerThread, serializes operations per connection,
rejects stale callback generations, and enforces the API 26 and API 31+
permission contracts without prompting. API 26 and API 35 instrumentation
verify the merged permission manifest. Android durable hosts now use AtomicFile
journals, non-exportable Keystore AES-GCM secrets, bounded
ParcelFileDescriptor/FileChannel recording and firmware access, one-shot
application material, and application-authorized OkHttp registrations. The
concrete framework contracts pass on API 26 and API 35.
The public Android client now exposes serial-verified discovery, connect and
reconnect, status observation, provisioning, normalized connection settings,
remove-only deprovision, authenticated factory reset, and exact-generation
reset receipt recovery. Application material stays behind opaque native
registrations, and every manager shares one facade operation owner. Recording
sync now returns native file paths, upload handoff exposes only ownership
outcomes, OTA keeps request and firmware bytes in native hosts, and logs expose
only complete core-sanitized lines. The AAR also carries a one-major deprecated
`com.bota.sdk` adapter frozen from Android revision `0f06d2a…`; JVM descriptor,
source, already-compiled bytecode, API 26, and API 35 consumer gates pass. New
applications resolve only `dev.bota:bota-android-sdk` and must not package the
old AAR beside it. See [Android SDK migration](docs/migration/android.md).
The release coordinator has accepted the Apple and Android physical-device
matrix for the `1.1.0` candidate, and the local React Native Android lifecycle
consumer passes against the immutable AAR. Maven Central publication and
remote Android consumer verification remain open until the protected release
workflow records them.
Ordinary CI builds one deterministic Android release payload and
runs that exact AAR through API 26 x86 and API 35 x86_64 instrumentation,
legacy migration, and unrelated Maven consumer lanes. The reviewed Maven
dependency policy is checked against both Gradle module metadata and the SPDX
SBOM. The protected `v1.1.0` release job signs only in memory, persists the
Central deployment UUID and state before polling, supports explicit recovery
without rebuilding or re-uploading, and byte-verifies the complete public
Maven directory before enabling API 26 and API 35 consumer smoke tests.
The native-boundary spike selected a manually owned C ABI after comparing it
with pinned UniFFI `0.32.0`. The versioned shipping crate now maps every core
command, host event, host effect, and workflow notification through typed
packets. Shared protocol decode/encode entry points cover the frozen status,
recording, transfer, OTA, provisioning, settings, and log fixtures. The Apple
package is the first public platform distribution; other native facades remain
unpublished.
ABI v1 is frozen at the typed public header and verified by standalone C and
Swift callers. Its exact ownership contract, artifact digests, packet coverage,
and platform exclusions are recorded in
[`release/evidence/1.0.0-alpha.1-native-abi.md`](release/evidence/1.0.0-alpha.1-native-abi.md).
The Apple package shell now builds an iOS device, universal iOS simulator, and
universal macOS XCFramework from that frozen header and proves a Swift package
can import the real ABI. Its Swift value models and protocol codecs are fixture
tested against the shared Rust implementation, including unknown wire values
and Bota Note connection normalization. A serialized Swift actor now drives the
real Rust workflow engine, preserves request/cancellation correlation, and
checks all 29 canonical workflow traces from generated SwiftPM resources. Its
host executor exhaustively routes all 30 ABI effect kinds through narrow native
ports, bounds raw payloads, and isolates cancelled or late completions.
A concrete CoreBluetooth driver now owns Apple delegate state on one serial
queue, while an actor host merges system-connected peripherals, deduplicates
scan results, serializes operations per peripheral, and preempts background
reconnect for manual selection. Native host services now atomically persist
non-secret workflow journals, isolate secrets in Keychain, keep recording and
firmware bytes in bounded files, resolve application material by opaque ID, and
stream URLSession progress without exposing paths or credentials to Rust. The
public `BotaDeviceClient` now configures those hosts once and exposes
serial-verified discovery, selected-device connection with identity learned
from GATT, strict known-serial connection, canonical reconnect, explicit
disconnect, connection observation, and decoded device-status streams. Client
destruction cancels active work, stops status subscriptions, disconnects the
verified peripheral, and closes observers. Public secure-lifecycle managers now
resolve provisioning and command-bound reset material through application
callbacks, normalize Bota Note connection settings, keep remove-only
deprovision separate from destructive reset, and resume only an exact durable
reset result for the current binding generation. Public recording, upload
ownership, OTA, and device-log managers now expose typed async streams while
keeping recording and firmware bytes in native files and accepting only opaque
application-supplied upload identifiers. An unrelated Swift package now imports
only `BotaAppleSDK`, runs a macOS smoke executable, and type-checks every public
manager. CI also compiles generic iOS device and simulator destinations with
strict concurrency diagnostics, then produces a deterministic XCFramework zip,
checksums, SPDX 2.3 SBOM, copied license, and validated release manifest as
release evidence. An opt-in physical target selects a device only by exact
serial verification and keeps settings, provisioning, recording deletion, OTA,
deprovision, and authenticated reset behind separate gates. Its default run
skips before client configuration. The supervised Bota Pin and Bota Note matrix
is not inferred from CI and remains a human release approval. The root Swift
package distributes the Apple facade for iOS and macOS while keeping the Rust
core in a checksummed XCFramework. This release does not replace the production
React Native package or claim Android, Flutter, Web, or Windows availability.

See [ARCHITECTURE.md](ARCHITECTURE.md) and the
[firmware compatibility matrix](protocol/compatibility/firmware-compatibility.json).

## Apple Installation

In Xcode, choose **File > Add Package Dependencies** and enter:

```text
https://github.com/bota-dev/app-sdk.git
```

Select version `1.1.0` or **Up to Next Major Version**, then add the
`BotaAppleSDK` product to an iOS 15+ or macOS 13+ target. Swift packages can
declare the dependency directly:

```swift
.package(url: "https://github.com/bota-dev/app-sdk.git", from: "1.1.0")
```

Import and configure the client from application code:

```swift
import BotaAppleSDK

let bota = BotaDeviceClient.shared
try await bota.configure()
```

iOS applications must provide `NSBluetoothAlwaysUsageDescription`. Sandboxed
macOS applications must enable **App Sandbox > Hardware > Bluetooth**, which
adds `com.apple.security.device.bluetooth`; macOS applications should also
provide the Bluetooth usage description shown to users.

## Development

Requirements:

- Node.js 22
- Rust 1.98.0 with rustfmt and Clippy
- Xcode 26 and CocoaPods 1.13 or newer for React Native Apple consumers; source
  verification locks CocoaPods 1.16.2, xcodeproj 1.27.0, and Bundler 2.6.9
- JDK 17, Android SDK 36, build-tools 35.0.0, NDK 28.2.13676358, and CMake
  3.22.1 for the Android facade

```bash
npm ci
npm run check
npm run test:release
npm run baseline:react-native:api -- --sdk-path ../react-native-sdk
npm run sync:android-fixtures
npm run sync:apple-fixtures
npm run test:fixtures
npm run test:workflows -- --sdk-path ../react-native-sdk
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
cargo xtask protocol generate --check
tools/ffi-smoke/run-native-c-smoke.sh
tools/ffi-smoke/run-native-swift-smoke.sh
tools/apple/test-package.sh
tools/apple/test-consumer.sh
cd frameworks/react-native
npm ci
bundle _2.6.9_ install
npm run verify
npm run test:apple:lifecycle
npm run test:apple:spm-workaround
bundle _2.6.9_ exec npm run test:apple:integration
# After the matching GitHub Release is public:
bundle _2.6.9_ exec npm run test:apple:remote-resolution
cd ../../platforms/android
./gradlew :sdk:testDebugUnitTest :sdk:lintRelease :sdk:assembleRelease
cd ../..
npm run test:android:foundation
tools/android/test-package.sh --api 35 \
  --instrumentation-class dev.bota.sdk.internal.jni.NativeCoreBridgeTest
tools/android/inspect-aar.sh platforms/android/sdk/build/outputs/aar/sdk-release.aar
tools/android/test-publication-graphs.sh
tools/android/package-release.sh --check
tools/android/install-release-repository.sh target/android-release target/android-m2
tools/android/test-emulator-lane.sh --api 26
tools/android/test-emulator-lane.sh --api 35
```

The React Native API check expects `npm ci` to have installed the reference SDK
checkout's `package-lock.json` tree so inherited and dependency-owned
declarations are included reproducibly in the frozen surface. Missing packages
are accepted only when the lock marks them optional for the current platform.
The replacement React Native package has its own lockfile so its native
toolchain does not enlarge the root tooling install. Its committed Codegen
contract is generated by React Native 0.86.3 for both iOS and Android. The
React Native pod therefore uses that release's iOS 15.1 floor. By default it
resolves the exact matching `BotaAppleSDK` release tag;
`BOTA_APPLE_SDK_PACKAGE_PATH` is only a source and CI override and must not be
used in a published application dependency. CI selects Xcode 26.3 and Ruby
3.3.12 explicitly and uses the locked Ruby toolchain. Main CI tests the nested
local package after building its XCFramework from source; the tag release
resolves the default remote package URL to the exact synchronized version after
publishing its binary archive.

On Android, the package consumes `dev.bota:bota-android-sdk` at the same
`sdk-version.toml` version. CI reconstructs a local Maven repository from the
immutable release payload, verifies the AAR digest, and runs the checked-in
Codegen/Kotlin consumer with
`tools/react-native/test-android-adapter.sh --repository target/android-m2`.

The pod includes a target-scoped compatibility hook for React Native 0.86.3's
duplicate binary Swift-package module maps on Xcode 26.3; applications do not
need to patch their Podfile for this combination.

The supervised Apple lab procedure is documented in
[docs/testing/apple-physical-device.md](docs/testing/apple-physical-device.md).
Normal development and CI must leave `BOTA_PHYSICAL_TESTS` unset.

The full reproducible gate includes the frozen React Native wire, test-count,
source-digest, and public-TypeScript-API comparators. Release evidence is
recorded in `release/evidence/`.

Release maintainers must follow [docs/releasing.md](docs/releasing.md). Release
tags must not be pushed until the protected `release` environment and its human
approval are configured.

## Naming

`app-sdk` is the source repository name. Public physical-device packages belong
to the **Bota App SDK** family. Customer-facing documentation and package names
follow this matrix:

| Platform | Documentation name | Package or module identifier |
|---|---|---|
| Apple | Bota SDK for Apple platforms | `BotaAppleSDK` |
| Android | Bota SDK for Android | `dev.bota:bota-android-sdk` |
| React Native | Bota SDK for React Native | `@bota.dev/react-native-sdk` |
| Flutter | Bota SDK for Flutter | `bota_flutter_sdk` |
| Web | Bota SDK for Web | `@bota.dev/web-sdk` |
| Windows | Bota SDK for Windows | `Bota.WindowsSdk` |
| Electron | Bota SDK for Electron | `@bota.dev/electron-sdk`, only when a dedicated native desktop bridge exists |

Electron applications use the Web SDK where Web Bluetooth satisfies the
capability matrix. A separate Electron SDK is published only when native
desktop BLE requires a distinct supported transport.

Internal Rust and C artifacts retain their existing `device-sdk` names. Future
backend API clients belong to a separate **Bota API SDK** family and repository.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and verification rules.
Report vulnerabilities using [SECURITY.md](SECURITY.md), not a public issue.

## License

MIT
