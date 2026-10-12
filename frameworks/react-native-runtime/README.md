# Bota React Native JavaScript runtime

Source candidate `@bota.dev/react-native-app-sdk-runtime@0.1.0-beta.0` is a separately
versioned JavaScript-only package. It is not yet published to npm. It has no
React Native dependency, native autolinking, CocoaPods/Maven dependency or Codegen
module. Build and update this control plane independently of the native adapter.

An application still supplies Bluetooth/file/crypto/background capabilities
through a conforming adapter. For an application already containing Bota's native
modules, the host can load those unchanged:

```ts
import { TurboModuleRegistry } from 'react-native';
import { createBotaReactNativeRuntime, type BotaDeviceAdapter,
  type BotaUploadBackendAdapter } from '@bota.dev/react-native-app-sdk-runtime';

const runtime = createBotaReactNativeRuntime({
  apiVersion: 1,
  device: TurboModuleRegistry.get('BotaDeviceSDK') as BotaDeviceAdapter | null,
  encryptedUploadBackend: TurboModuleRegistry.get('BotaUploadV2Backend') as BotaUploadBackendAdapter | null,
});
await runtime.client.configure({ environment: 'production' });
```

Keep the application/native adapter version fixed when deploying compatible
JavaScript OTA updates. New native methods, transport fixes or a changed native
contract require an application build. A fresh application needs a separately
installed conforming adapter; this package alone cannot access physical hardware.
Registry publication and OTA/hardware acceptance have not happened in this change.

The ordinary `@bota.dev/react-native-app-sdk` remains the bundled/native-adapter
distribution with its existing setup. Both distributions compile one authoritative
TypeScript implementation; there is no duplicated protocol or workflow fork.
See [runtime contracts and evidence](../../docs/parity/react-native-runtime.md).

Generated JavaScript and declaration identities both report this package's own
version. Build output omits platform-only declarations and dangling source-map
references; the authoritative workflow source remains in the RN package.
