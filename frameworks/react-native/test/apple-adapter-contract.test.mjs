import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const packageRoot = resolve(new URL('..', import.meta.url).pathname);
const contract = JSON.parse(
  readFileSync(resolve(packageRoot, 'generated/codegen-contract.json'), 'utf8')
);
const moduleContract = contract.schema.modules.NativeBotaDeviceSDK;

test('Apple adapter implements the complete generated lifecycle module', () => {
  const objectiveCpp = readFileSync(
    resolve(packageRoot, 'ios/BotaDeviceSDK.mm'),
    'utf8'
  );
  const swift = readFileSync(
    resolve(packageRoot, 'ios/BotaDeviceSDKAppleBridge.swift'),
    'utf8'
  );

  assert.equal(moduleContract.moduleName, 'BotaDeviceSDK');
  assert.match(objectiveCpp, /RCT_EXPORT_MODULE\(BotaDeviceSDK\)/);
  assert.match(objectiveCpp, /BotaDeviceSDK-Swift\.h/);
  assert.match(objectiveCpp, /NativeBotaDeviceSDKSpecJSI/);
  assert.match(objectiveCpp, /BotaRejectAppleError/);

  for (const method of moduleContract.spec.methods) {
    assert.match(
      objectiveCpp,
      new RegExp(`- \\(void\\)${method.name}\\b`),
      `Objective-C++ adapter is missing ${method.name}`
    );
  }

  assert.match(swift, /@objc\(BotaDeviceSDKAppleBridge\)/);
  assert.match(swift, /BotaDeviceSDKAppleLifecycle/);
  assert.match(swift, /configureWithApplicationSupportDirectory:logLevel:completion:/);
  assert.match(swift, /destroyWithCompletion:/);
  assert.match(swift, /stateWithCompletion:/);
});
