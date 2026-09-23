# AGENTS.md

## Scope

This directory is the public `bota_flutter_sdk` plugin. Dart is a typed facade;
`BotaAppleSDK` and `dev.bota:bota-android-sdk` retain Bluetooth, files, network
resources, and workflow execution.

## Invariants

- Support Flutter iOS 15+ and Android API 26+ only. Do not advertise Web,
  macOS, Windows, Linux, or native live-audio streaming.
- Keep recording and firmware bodies, raw BLE packets, native handles, grants,
  tokens, credentials, and private material out of Dart event streams and logs.
- Application callbacks are request-bound and one-shot. Missing provisioning,
  reset, persistence, or firmware integration must fail closed.
- Reconnect verifies the exact serial. Names and platform hints are never
  identity.
- Batch transfer uses a native file and defaults to retaining the device copy.
  Confirm only after the application upload succeeds.
- Remove-only deprovision retains recordings and is never factory reset.
  Factory reset uses the exact command ID and binding generation and persists
  the result before receipt acknowledgement.
- Dart maps typed Pigeon values only. Do not add workflow reducer logic outside
  Rust or manually edit generated Pigeon outputs.
- One `PigeonBotaPlatform` belongs to one Flutter engine. Destroy is terminal
  and idempotent; late events and callback responses remain rejected.

## Android Build

The consumable Android project applies AGP and Kotlin without versions because
the Flutter application owns its plugin classpath. The standalone
`android/settings.gradle.kts` and temporary adapter-test root pin AGP `8.13.2`
and Kotlin `2.1.20`. Use `LibraryExtension` and Kotlin `compilerOptions` APIs so
the plugin also compiles inside the pinned Flutter-generated consumer.

`android/sdk-version.toml` is packaged with the plugin and must match the root
`sdk-version.toml`. Local consumer tests reserve the `dev.bota` group for the
fresh repository under `target/android-m2`; they must not resolve a cached or
remote substitute.

## Apple Build

The Swift Package and CocoaPods integrations compile the same adapter source in
Swift 5 language mode. Public metadata resolves the exact synchronized
`BotaAppleSDK` and contains no local override. Local adapter and consumer tools
patch only disposable copies of the Swift manifest to use the nested Apple
source package. Those overrides must retain the public package identity
`app-sdk`; `BotaAppleSDK` is the product name. Never add
`BOTA_APPLE_SDK_PACKAGE_PATH` to public package files.

## Release Candidate

`tools/flutter/package-release.sh --check` is the complete local publication
gate for selected synchronized `1.2.0-beta.6`; it must fail closed for occupied
`1.2.0-beta.0`. It verifies
synchronized metadata, Pigeon drift, formatting, analysis,
all Dart tests, hosted dependency licenses, `flutter pub publish --dry-run`,
and fresh Android and iOS consumers before preserving a deterministic archive,
normalized inventory, lock, manifest, and evidence under
`target/flutter-release/`. The archive verifier rejects hidden/local files,
build outputs, credentials, links, unsafe paths, extras, and checksum drift.
The command prepares evidence only; it must never publish a package.

Automatic PR/main CI uses `tools/flutter/package-release.sh --ci` to run the
same verification. Occupied beta.0 returns `candidate-ready=false` without a
release directory; beta.1 and later synchronized versions return
`candidate-ready=true` and preserve the deterministic candidate.

## Example

Keep `example/` limited to maintained application files. The consumer gate
generates complete disposable platform scaffolds, copies these files in, checks
Bluetooth permissions, builds release outputs, and deletes the temporary tree.
Backend stubs must throw clearly and must never print secrets or request
material.

## Verification

Run from the repository root:

```bash
tools/flutter/run-flutter.sh test frameworks/flutter/bota_flutter_sdk/test
tools/flutter/test-android-adapter.sh
tools/flutter/test-apple-adapter.sh
tools/flutter/test-consumers.sh
npm run flutter:verify
tools/flutter/package-release.sh --ci
tools/flutter/package-release.sh --check
tools/flutter/run-dart.sh format --output=none --set-exit-if-changed \
  frameworks/flutter/bota_flutter_sdk/lib \
  frameworks/flutter/bota_flutter_sdk/test \
  frameworks/flutter/bota_flutter_sdk/example/lib
```

The workflow conformance suite must discover all 33 scenarios from the
canonical `protocol/workflows/*.json` files, replay the 29 Flutter-supported
traces, and explicitly classify the four Encrypted Upload v2 traces as
unsupported. The fake host may translate each fixture's decided terminal
outcome into typed bridge values; it must not copy a workflow reducer into
Dart. Encrypted Upload v2 staging and receipt-confirmed deletion are not
exposed by this beta and must not be routed through legacy batch transfer.
