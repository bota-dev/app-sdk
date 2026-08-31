import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const specPath = join(root, 'src/specs/NativeBotaDeviceSDK.ts');
const indexPath = join(root, 'src/index.ts');

test('Codegen contract freezes the lifecycle module identity and methods', () => {
  const source = readFileSync(specPath, 'utf8');

  assert.match(source, /interface Spec extends TurboModule/);
  assert.match(source, /configure:\s*\(/);
  assert.match(source, /readonly onDeviceDiscovered:\s*EventEmitter/);
  assert.match(source, /readonly onDeviceStatusUpdated:\s*EventEmitter/);
  assert.match(source, /readonly onProvisioningMaterialRequested:\s*EventEmitter/);
  assert.match(source, /startScan:\s*\(/);
  assert.match(source, /stopScan:\s*\(/);
  assert.match(source, /connectSelected:\s*\(/);
  assert.match(source, /reconnect:\s*\(/);
  assert.match(source, /disconnect:\s*\(/);
  assert.match(source, /deprovision:\s*\(/);
  assert.match(source, /provision:\s*\(/);
  assert.match(source, /resolveProvisioningMaterial:\s*\(/);
  assert.match(source, /rejectApplicationMaterial:\s*\(/);
  assert.match(source, /readStatus:\s*\(/);
  assert.match(source, /startStatusUpdates:\s*\(/);
  assert.match(source, /stopStatusUpdates:\s*\(/);
  assert.match(source, /destroy:\s*\(/);
  assert.match(source, /getCapabilities:\s*\(/);
  assert.match(source, /getState:\s*\(/);
  assert.match(
    source,
    /TurboModuleRegistry\.get<Spec>\(['"]BotaDeviceSDK['"]\)/
  );
  assert.doesNotMatch(source, /getEnforcing/);
});

test('package root exports the React Native device facade types', () => {
  const source = readFileSync(indexPath, 'utf8');

  assert.match(source, /BotaDeviceSDKDeviceClient/);
  assert.match(source, /BotaDeviceSDKProvisioningClient/);
  assert.match(source, /BotaEventSubscription/);
  assert.match(source, /BotaAsyncEventSubscription/);
  assert.match(source, /BotaProvisioningMaterialProvider/);
});

test('Codegen contract does not carry high-volume binary data', () => {
  const source = readFileSync(specPath, 'utf8');
  const forbidden = [
    /ArrayBuffer/i,
    /Uint8Array/i,
    /base64/i,
    /(?:recording|firmware)(?:Data|Payload|Bytes|Chunk)/i,
    /(?:data|payload|bytes|chunk)\??\s*:/i,
  ];

  for (const pattern of forbidden) {
    assert.doesNotMatch(source, pattern);
  }
});
