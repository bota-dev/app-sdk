# App SDK Package Names

Current target: `2.0.0-beta.7`. Exact source CI and License Gate are required;
the [release evidence](../../release/evidence/2.0.0-beta.7-preflight.md) links
publication and clean public-consumer results. Confirm synchronized completion
there before installing the versions below. Package availability, application
rollout and physical acceptance remain separate claims.

**Bota App SDK** connects applications to physical Bota devices. The future
**Bota API SDK** is a separate family for backend API clients.

| Platform | Historical 1.x identifier | 2.x identifier |
| --- | --- | --- |
| Apple product/module and CocoaPod | `BotaAppleSDK` | `BotaAppSDK` |
| Android Maven | `dev.bota:bota-android-sdk` | `dev.bota:bota-app-sdk` |
| React Native npm | `@bota.dev/react-native-sdk` | `@bota.dev/react-native-app-sdk` |
| Web npm | `@bota.dev/web-sdk` | `@bota.dev/web-app-sdk` |
| Flutter pub.dev and Dart library | `bota_flutter_sdk` | `bota_app_sdk` |

Existing releases, tags, checksums, and old npm dist-tags remain unchanged.
Production RN stays on `@bota.dev/react-native-sdk@0.0.x`. Applications must update their exact dependency pins and rebuild native binaries. Windows and a dedicated Electron facade
are outside this release.

## Replace, Do Not Co-install

Remove the old facade before adding its replacement. Both contain the same
native runtime identities and must not be installed together. Rebuild RN and
Flutter native apps; a JavaScript bundle update is insufficient. There is no
compatibility forwarding package.

### Apple

Keep the repository URL, pin `2.0.0-beta.7`, select product `BotaAppSDK`, and
replace `import BotaAppleSDK` with `import BotaAppSDK`:

```swift
.package(url: "https://github.com/bota-dev/app-sdk.git", exact: "2.0.0-beta.7")
.product(name: "BotaAppSDK", package: "app-sdk")
```

For CocoaPods, use `pod 'BotaAppSDK', '2.0.0-beta.7'` instead of the old pod.
The existing `BotaAppleSDKVersion` metadata type remains available from the
new module. Runtime types and core binary names do not change.

### Android

```kotlin
implementation("dev.bota:bota-app-sdk:2.0.0-beta.1")
```

Kotlin/Java namespaces, including the legacy adapter namespace, do not change.

### React Native

```sh
npm uninstall @bota.dev/react-native-sdk
npm install --save-exact @bota.dev/react-native-app-sdk@2.0.0-beta.7
npx pod-install
```

```ts
import { BotaClient, BotaDeviceSDK } from '@bota.dev/react-native-app-sdk';
```

The `BotaDeviceSDK` native module, `BotaDeviceSDKSpec` Codegen identity, RN
and native OS floors remain unchanged by the package rename. The current
React Native facade requires React 19.2.3+, RN 0.86.3+, Android API 26+ and
iOS 15.1+. Remove standalone BLE packages and use one native SDK owner.
Compatibility presence uses snake_case `SdkClientContext`; modern camelCase
presence uses `BotaClientPresenceContext`. Native files replace JS byte stores;
supply scoped backend completion through `createUploadRecoveryProvider`.

### Web

```sh
npm uninstall @bota.dev/web-sdk
npm install --save-exact @bota.dev/web-app-sdk@2.0.0-beta.7
```

```ts
import { BotaDeviceClient } from '@bota.dev/web-app-sdk';
```

Tenant-scoped persistence, permissions, and browser requirements do not change.

### Flutter

Remove `bota_flutter_sdk`, add `bota_app_sdk: 2.0.0-beta.7`, then import:

```dart
import 'package:bota_app_sdk/bota_app_sdk.dart';
```

Pigeon retains its internal `bota_flutter_sdk` channel prefix, native namespaces
and plugin classes. Only public package/import and source paths change.

Beta.1 reads the normal application's `local.properties` Flutter SDK path;
the explicit `BOTA_FLUTTER_HOME` workaround is only needed by immutable beta.0.
See the [beta.0 workaround](../../frameworks/flutter/bota_app_sdk/README.md#android-beta0-build-workaround)
and [beta.1 publication evidence](../../release/evidence/2.0.0-beta.1-publication.md).

## Release Gates

New identities need their own registry ownership and publisher setup; old
package authorization does not transfer. Local and exact-revision main-CI
gates precede publication, and native prerequisites precede RN/Flutter public
consumers. npm uses `beta`, preserves old tags, and rejects ambiguous registry
errors. Each npm attempt snapshots both legacy packages and checks their tags
even if publication fails. RN publication also requires the legacy `latest`
tag to remain on a stable `0.0.x` maintenance version. The Apple binary is
made public and compared byte-for-byte before npm publication on both normal
and recovery paths. Flutter source validation rejects missing or mixed old/new
native facade dependencies. Recovery selects names from the verified release version and preserves
signed Central bytes and deployment UUIDs.

RN/Web `beta` now selects beta.6; `latest` stays at beta.0. Actual new-name
npm and pub.dev OIDC uploads passed in beta.1. Registry propagation can lag
publication; resume verification of the same occupied version instead of
re-uploading or moving its tag.

Physical acceptance is **NOT RUN** for this candidate. Source tests, package
publication, app rollout, and device acceptance are separate claims. See
[the release process](../releasing.md).
