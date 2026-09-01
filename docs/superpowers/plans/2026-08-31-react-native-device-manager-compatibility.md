# React Native DeviceManager Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the frozen `0.0.65` `DeviceManager` class over the synchronized
Apple and Android native facades without exposing an incomplete runtime export.

**Architecture:** A JavaScript compatibility owner preserves EventEmitter,
scan, connection, cache, and synchronous-subscription behavior while delegating
all BLE work to `BotaDeviceSDK`. Direct device commands that are not yet in the
low-volume TurboModule contract are added as typed native-facade operations.
The class remains internal until its semantic surface and behavior gates pass.

**Tech Stack:** TypeScript 6.0.3, eventemitter3 5.0.1, React Native 0.86.3
Codegen, Swift 6, Kotlin 2.1.20, XCTest, JUnit 4, Node test runner.

**Spec:** `protocol/baseline/react-native-public-api-0.0.65.json`,
`docs/superpowers/plans/2026-08-28-app-sdk-implementation.md` Milestone 4,
and `ARCHITECTURE.md` React Native boundary.

## Global Constraints

- Keep `@bota.dev/react-native-sdk` private until all five runtime classes,
  application acceptance, and release gates pass.
- Keep the public `DeviceManager` constructor exactly `() => DeviceManager`.
- Never use an advertised name as reconnect identity; reconnect is serial-strict.
- Keep credentials, grants, packet bytes, recording bytes, and firmware bytes
  out of compatibility state and EventEmitter events.
- A synchronous legacy removal function may start asynchronous native cleanup,
  but native ownership must still stop exactly once.
- Do not export `DeviceManager` from `src/index.ts` until the exact frozen
  semantic-surface test includes it and passes.

---

### Task 1: Add The Internal Compatibility Owner

**Files:**
- Create: `frameworks/react-native/src/compatibility/runtime.ts`
- Create: `frameworks/react-native/src/managers/DeviceManager.ts`
- Modify: `frameworks/react-native/package.json`
- Modify: `frameworks/react-native/package-lock.json`
- Test: `frameworks/react-native/test/device-manager-compatibility.test.mjs`

**Interfaces:**
- Consumes: `BotaDeviceSDKClient` and the existing `devices`, `logs`,
  `provisioning`, and `wifi` facades.
- Produces: internal `DeviceManager` plus
  `setCompatibilityClientForTesting(client | null)`; neither is exported from
  the package root in this task.

- [x] **Step 1: Write the failing behavior test**

Create a fake `BotaDeviceSDKClient` that records native calls and verify:

```js
const manager = new DeviceManager();
await manager.startScan({ minRssi: -70 });
fake.emitDiscovered(discovered);
assert.deepEqual(manager.getDiscoveredDevices(), [discovered]);
const connected = await manager.connect(discovered);
assert.deepEqual(manager.getConnectedDevices(), [connected]);
assert.deepEqual(
  await manager.configureWiFi(connected.id, credentials, grant),
  { success: true }
);
```

Also verify event order, WiFi cache updates, and that calling each legacy
subscription remover twice causes one native stop.

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
cd frameworks/react-native
PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" npm test -- \
  test/device-manager-compatibility.test.mjs
```

Expected: fail because `lib/module/managers/DeviceManager.js` does not exist.

- [x] **Step 3: Add the frozen EventEmitter dependency**

Run:

```bash
cd frameworks/react-native
PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" \
  npm install --save-exact eventemitter3@5.0.1
```

- [x] **Step 4: Implement stateful delegation**

`runtime.ts` owns only the package singleton selection and test replacement:

```ts
let compatibilityClient: BotaDeviceSDKClient = BotaDeviceSDK;
export const getCompatibilityClient = () => compatibilityClient;
export const setCompatibilityClientForTesting = (
  client: BotaDeviceSDKClient | null
) => { compatibilityClient = client ?? BotaDeviceSDK; };
```

`DeviceManager` extends `EventEmitter<DeviceManagerEvents>`, tracks discovered
and connected devices, owns one scan subscription, translates native async
subscriptions to idempotent legacy removers, and maintains the frozen WiFi
cache merge rules. Implement only methods whose BLE work already delegates to a
native facade; keep the class internal.

- [x] **Step 5: Verify GREEN**

Run `npm run verify` and both native adapter lifecycle suites. Expected: all
existing checks plus the new compatibility behavior test pass.

- [x] **Step 6: Document and commit**

Update `AGENTS.md`, `ARCHITECTURE.md`, and `README.md` to state that the internal
compatibility owner exists but the public class is still withheld. Commit only
Task 1.

---

### Task 2: Add Missing Low-Volume Device Commands

**Progress (2026-08-31):** The first focused slice covers provisioning-state,
device-public-key, auth-nonce, API-endpoint, certificate, backend-public-key,
recording-grant, and time-sync commands through Rust, Apple, Android, Codegen,
and the internal compatibility owner. A second focused slice now carries
recording start/stop results plus recording-state reads and one owned state
stream through Rust, Apple, Android, and Codegen. The corresponding internal
`DeviceManager` behavior and reset compatibility remain in Task 2 and will be
committed separately.

**Files:**
- Modify: `frameworks/react-native/src/specs/NativeBotaDeviceSDK.ts`
- Modify: `frameworks/react-native/src/client.ts`
- Modify: `frameworks/react-native/ios/BotaDeviceSDK.mm`
- Modify: `frameworks/react-native/ios/BotaDeviceSDKAppleBridge.swift`
- Modify: `frameworks/react-native/android/src/main/java/dev/bota/sdk/reactnative/BotaDeviceSDKModule.kt`
- Modify native Apple and Android public device facades under `platforms/`
- Test native facade, adapter, Codegen, and compatibility files beside each layer

**Interfaces:**
- Consumes: the selected `ConnectedDevice` and native operation coordinator.
- Produces typed methods for nonce/public-key/provisioning-state reads, endpoint,
  certificate, backend-key, grant, time-sync, and recording-control writes.

- [ ] **Step 1: Freeze direct-command behavior from `0.0.65`**

Add byte fixtures and native tests for each exact characteristic, payload,
subscribe-before-write rule, result mapping, timeout, and cancellation path.

- [ ] **Step 2: Verify RED at Rust, Apple, Android, and Codegen boundaries**

Each test must fail because its typed facade method or Codegen method is absent.

- [ ] **Step 3: Implement shared codecs and native facades**

Keep wire bytes native. Public native methods accept typed values and return
typed results; direct command methods share the same per-device operation
coordinator as connection, provisioning, reset, and WiFi.

- [ ] **Step 4: Add low-volume Codegen methods**

Codegen may carry strings, booleans, numeric status, and certificate/public-key
text. It must not carry raw characteristic packets or recording bodies.

- [ ] **Step 5: Complete the corresponding internal `DeviceManager` methods**

Every frozen method delegates to the new client facade and preserves frozen
errors and result shapes.

- [ ] **Step 6: Run full native and React Native integration gates**

Require Rust tests, `swift test`, Android unit/lint/API checks, React Native
package verification, the CocoaPods linked consumer, and the immutable-AAR
Android adapter consumer.

- [ ] **Step 7: Document and commit**

Update every doc hit for the new command symbols, then commit Task 2 separately.

---

### Task 3: Close DeviceManager Surface And Export It

**Files:**
- Modify: `frameworks/react-native/src/managers/DeviceManager.ts`
- Modify: `frameworks/react-native/src/index.ts`
- Modify: `frameworks/react-native/test/compatibility-surface.test.mjs`
- Test: `frameworks/react-native/test/device-manager-compatibility.test.mjs`

**Interfaces:**
- Consumes: every native-backed method completed by Tasks 1 and 2.
- Produces: public frozen `DeviceManager` export with no placeholder method.

- [ ] **Step 1: Add the class to the exact semantic-surface comparison**

Remove only `DeviceManager` from `deferredWorkflowClasses`. Expected RED until
constructor, inherited EventEmitter API, members, and static members match.

- [ ] **Step 2: Complete reconnect registry and auto-reconnect behavior**

Preserve one active native reconnect attempt, serial-strict identity, known BLE
ID updates after connection, user-disconnect pause, and idempotent teardown.

- [ ] **Step 3: Verify every frozen method has a native-backed test**

Generate the frozen member list from the baseline and fail if any method lacks
a named behavior case. Do not satisfy this gate with an unsupported-operation
stub.

- [ ] **Step 4: Export and verify**

Export `DeviceManager`, run `npm run verify`, both linked native consumers, and
the frozen baseline extraction. Expected: 76 of 80 exports match, with only
`BotaClient`, `RecordingManager`, `StreamingSession`, and `OTAManager` deferred.

- [ ] **Step 5: Document, commit, and push `main`**

Update status counts and milestone evidence, commit the export independently,
and push only after the clean-tree release gates pass.

---

## Self-Review

- Spec coverage: all frozen `DeviceManager` members are assigned to an existing
  facade, Task 2 direct-command facade, JavaScript cache/event ownership, or
  reconnect ownership before export.
- Placeholder scan: no method is permitted to throw an unimplemented or
  feature-unavailable placeholder at the Task 3 gate.
- Type consistency: `DeviceManager` retains the zero-argument constructor and
  frozen public method signatures; test injection stays in a non-root module.
- Remaining scope: `RecordingManager`, `StreamingSession`, `OTAManager`, and
  `BotaClient` require separate plans because upload/streaming/download byte
  ownership differs from low-volume `DeviceManager` operations.
