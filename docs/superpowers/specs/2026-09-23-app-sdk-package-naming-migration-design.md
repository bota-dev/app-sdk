# App SDK Package Naming Migration

**Status:** Migration design approved on 2026-09-23. Source migration and
version-aware recovery implemented on local main; final candidate verification,
main CI and registry authorization/publication remain pending. Physical-device
acceptance is unchanged and NOT RUN for this candidate.

## Intent

Make the **Bota App SDK** family recognizable in the package identifiers that
customers install and import, distinct from the future **Bota API SDK**.
The repository remains `app-sdk`. Documentation uses **Bota App SDK for
<platform>**.

The previous naming decision deliberately used platform-only identifiers.
This design replaces that policy for a future release; it does not claim that
the new packages exist or rewrite the identity of any published artifact.
The README matrix remains the current implementation authority until the
migration lands.

## Target Names

| Platform | Existing identifier | Target identifier |
| --- | --- | --- |
| Apple SwiftPM product and import, CocoaPod | `BotaAppleSDK` | `BotaAppSDK` |
| Android Maven artifact | `dev.bota:bota-android-sdk` | `dev.bota:bota-app-sdk` |
| React Native npm package | `@bota.dev/react-native-sdk` | `@bota.dev/react-native-app-sdk` |
| Web npm package | `@bota.dev/web-sdk` | `@bota.dev/web-app-sdk` |
| Flutter pub.dev package and Dart library | `bota_flutter_sdk` | `bota_app_sdk` |

Apple developers will use `import BotaAppSDK`; Flutter developers will use
`package:bota_app_sdk/bota_app_sdk.dart`. Android Kotlin imports remain under
`dev.bota.sdk`: Maven coordinates and language namespaces are separate
contracts. React Native and Web keep their existing exported client APIs.

Windows and a potential dedicated Electron distribution are outside this
migration. Do not create placeholder packages or publish those platforms. Their
identifiers must be decided before their own release gates.

## Version And Compatibility Boundary

Apple `1.0.0` and the synchronized `1.1.0` artifacts already exist. Calling the
current line beta does not make a Swift product or module rename non-breaking.
Use **`2.0.0-beta.0`** as the first synchronized version under the new names,
subject to an unoccupied-version check before selecting the candidate.

All five target distributions still use one version from `sdk-version.toml`.
Update the release-channel validator deliberately: allow the new major beta
line while retaining exact recovery of previously accepted release identities.
Do not relax the beta-only publication policy or change historical evidence to
make new packages appear compatible with old inventories.

- Keep every published package, Git tag, release asset, and checksum unchanged.
- Keep the maintenance `@bota.dev/react-native-sdk@0.0.x` line and its `latest`
  tag supported. Its source and release process remain separate.
- Leave old monorepo RN/Web versions and their existing dist-tags unchanged.
  Future monorepo candidates publish to the new package names, not both names.
- Publish new npm packages explicitly under `beta`; do not deliberately promote
  any beta to `latest`. Verify the new package's registry state after its first
  publication, including whether `latest` exists, rather than assuming it has
  the old package's tag history.
- Existing consumers stay on their exact old versions until explicitly
  migrated. New Apple consumers retain the same Git repository URL but change
  the selected product, imports, and exact version.
- Do not ship compatibility wrappers, relocation artifacts, or duplicate
  native facades as part of this change. These would add another maintained
  distribution surface. Document the installation/import migration instead.
- An application must replace, not co-install, old and new facade packages.
  RN native module identifiers and Android class names intentionally remain
  identical; installing both implementations is unsupported.

Preparing this design does not resume, cancel, or rename the in-flight
`v1.2.0-beta.12` release. Any completion of that release must use its original
tagged sources and preserved candidate bytes. It cannot publish the new names.

## Changes Required

### Apple And Android

Update root and development Swift manifests, Swift module paths and imports,
CocoaPods metadata, packaging scripts, consumer fixtures, and facade-dependent
RN/Flutter integrations together. Rename public Apple archive/license filenames
where they encode the facade name, but preserve the internal core XCFramework
and C module identities.

Update the Android Maven artifact, generated POM, repository paths, release
inventories, verifier inputs, consumer dependencies, and RN/Flutter dependency
metadata. Keep Kotlin packages, JNI symbols, shared-object names, legacy
`com.bota.sdk` compatibility behavior, and runtime storage identity unchanged.

### React Native, Web, And Flutter

Update npm names, lockfile package identities, tarball discovery, installed
consumer imports, release metadata, and package-specific trusted-publisher
configuration. A publisher authorized for an old npm name is not release
evidence for its replacement. Preserve the frozen RN baseline as a reference
to the actual maintenance package, rather than mechanically renaming it.

Update Flutter's package name, primary Dart library, source directory, imports,
examples, package inventory, pubspec, and native dependencies. Keep plugin
class names, native namespaces, and explicit Pigeon channel identities stable.
Regenerate bindings with the pinned toolchain and inspect generated changes
instead of editing them manually. Any tool-derived channel-name change must
be identified and reviewed, not assumed to be cosmetic.

Keep `BotaDeviceSDK`, `BotaDeviceSDKSpec`, `BotaDeviceClient`, `BotaClient`,
`bota-device-sdk-core`, `bota-device-sdk-ffi`, `BotaDeviceSDKC`, and all
`bota_device_sdk_v1_*` symbols unchanged. This is a distribution migration, not
a protocol, API behavior, state-storage, or runtime architecture redesign.

### Release Identity And Documentation

Update manifest validation, package-name expectations, license inventories,
packaging/recovery tooling, and candidate gates to distinguish historical and
new identities. Old manifests must validate against their historical package
matrix; a new candidate must not mix old and new facade identities. Keep
`sdkFamily: "bota-app-sdk"` unchanged.

Update current installation examples, README, architecture and agent context,
release runbooks, the private App SDK architecture, and public client-SDK docs
in the same implementation. Preserve historical release evidence, baseline
fixtures, and maintenance-package instructions. Do not migrate Demo or Bota One
dependencies automatically; their packed-package and native rebuild acceptance
remains a separate consumer rollout.

## Publishing Prerequisites

Before tagging, verify registry availability and organization ownership for
each new package. Configure and verify the exact npm trusted publishers and
the CocoaPods/pub.dev ownership and bootstrap paths. Retain the protected
GitHub release approval gate and existing signing/provenance protections.
Do not introduce stored npm tokens to work around new-name setup.

Use the successful main-CI candidate inventory for the new tag. Preserve exact
native and npm candidates, publish native dependencies before framework
consumers, and bootstrap Flutter only from the ordered, verified release
artifact. A name change never authorizes repacking an occupied version.

## Acceptance

1. Tests reject a mixed-name new candidate and accept unchanged historical
   manifests and recovery inputs. Channel tests accept the new major beta,
   reject stable publication under beta policy, and protect maintenance tags.
2. Apple SwiftPM and CocoaPods consumers compile with `import BotaAppSDK` on
   supported iOS/macOS targets. Android consumers resolve only the new Maven
   artifact and pass the existing compatibility and emulator gates.
3. RN preserves its frozen public surface and native-module contract; packed
   consumers resolve the matching renamed native artifacts without duplicate
   modules. Web's packed Vite/WASM consumer and browser tests pass.
4. Flutter analysis, tests, package dry run, archive verification, and fresh
   iOS/Android consumers pass under `bota_app_sdk` against exact native versions.
5. Post-publication verification proves the public artifact bytes match the
   approved candidates and that old registry versions and tags are unchanged.
   First-package ownership or login steps are reported as external gates until
   actually completed.
6. Physical-device acceptance remains separate and retains its actual status.
   A successful rename, build, or publication does not provide hardware evidence.

## Review Boundary

This document records the approved naming direction, breaking version, and
migration mechanics. The [implementation plan](../plans/2026-09-23-app-sdk-package-naming-migration.md)
turns those decisions into testable changes. No source identifiers, registry
settings, package versions, or application dependencies are changed by this
documentation-only step.
