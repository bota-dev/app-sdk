# Private React Native JavaScript verification fixture

This directory is a private source fixture, not an application dependency or npm
publication target. It retains its internal identity/version and compiles the
authoritative RN facade and generated Rust artifact without React Native imports,
native autolinking, CocoaPods/Maven dependencies or a Codegen module.

Applications use `@bota.dev/react-native-app-sdk/runtime` from the original public
package. Synchronized beta.16 prepares that generated-JS route; beta.15 remains
published. Canonical artifact preparation and local source checks pass; final
CI/License, complete inventory, protected publication and public consumers remain
pending. The complete public package
retains native compatibility and autolinking, while `/runtime` evaluates without
native modules or WebAssembly. See [application setup](../react-native/README.md)
and [beta.16 preflight](../../release/evidence/2.0.0-beta.16-preflight.md).

The following application source example uses the original package's runtime
entry and requires the generated factory after beta.16 publication is verified:

```ts
import {
  createBlePlxPort,
  createBotaReactNativeJsRuntime,
  type BotaJsHostPorts,
} from '@bota.dev/react-native-app-sdk/runtime';

const lifetime = new AbortController();
const ports: BotaJsHostPorts = {
  apiVersion: 1,
  platform: 'ios',
  signal: lifetime.signal,
  checkScope: assertCapturedScope,
  ble: createBlePlxPort(installedBleManager),
  persistence: privateScopedPersistence,
  files: reopenableScopedFiles,
  randomBytes: secureRandomBytes,
  network: registeredNetworkTransfers,
  lifecycle: installedLifecycle,
};
const runtime = createBotaReactNativeJsRuntime(ports, {
  backend: { fetch: redirectRefusingHttps },
  uploadFile: uploadOpaqueFile,
  openSocket: openAuthenticatedSocket,
});
await runtime.client.configure({ environment: 'production' });

// Stop and await the captured account/project/device scope on teardown:
lifetime.abort();
await runtime.client.destroy();
```

The generic BLE port reports actual radio and permission state through optional
`readBluetoothState`/`observeBluetoothState` ports, normalized by generated Rust.
Without those observations the generated client remains `unknown`, and
`waitForBluetooth` cannot report readiness. Teardown joins state observations.

Host values implement the exported structural interfaces. BLE can use an
installed generic `react-native-ble-plx` manager through the supplied JS port.
Hosts own permissions and manager lifetime. Files provide scoped reopening,
exact durable append, bounded reads and flush/readback; persistence atomically
saves private journals in one captured namespace. HTTPS/file upload must refuse
redirects before forwarding credentials/data and join aborts. Optional WSS must
preserve the qualified BYO subprotocol and join pending I/O on close. Default RN
XHR-backed fetch does not provide the required pre-redirect credential fence.

Rust chooses framing, retry, recovery and receipt-gated cleanup. JS executes OS
effects. Ciphertext and signed documents are bounded SDK-internal transport
values; public APIs return metadata/progress/results. V2/BYO signing/decryption
keys remain on the device or behind installed secure handles. The legacy private
PEM import is a tracked compatibility gap, not the modern key model; this runtime
adds no private-key export or signing authority.

Managed v2, BYO and protected status use the runtime backend factories. Custom v2
providers use `readEncryptedUploadV2AuthNonce(operationId)`,
`registerEncryptedUploadV2Material` and `releaseEncryptedUploadV2Material` with
the exact pending operation and physical owner. See the
[material example and complete port contract](../../docs/parity/react-native-runtime.md).

Generated firmware update follows the canonical Rust OTA/reboot recovery loop.
`firmwareRecovery.timeoutMs` may narrow its budget; `delayMs` is a legacy
full-adapter option. `createBotaReactNativeRuntime` remains available for existing
version-1 full SDK adapters, including installed native Bota modules.

Compatible generated-code/facade fixes can travel in an app OTA bundle when its
installed OS ports satisfy API version 1. Adding an OS capability, fixing an
installed transport or changing that contract requires an app build. Fresh apps
install generic host capabilities once. Publication of the original package,
app OTA and physical acceptance remain separate from source validation.

The private fixture and public runtime entry compile one authoritative RN facade
and committed Rust artifact. Maintainer/CI regeneration uses the locked compiler;
consumers build from committed JS without Cargo, Gradle or Xcode. The public entry
reports the original SDK package/version; the fixture reports its internal test
identity. Maintainers run `npm run verify --prefix frameworks/react-native-runtime`
from the repository root. Source checks are recorded in the
[runtime review](../../docs/parity/react-native-runtime.md).

The package is MIT-licensed. Retain [third-party notices](THIRD_PARTY_NOTICES.md)
and full license texts when redistributing the compiled SDK.
