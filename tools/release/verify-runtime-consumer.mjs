import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { join, resolve } from 'node:path';

const [directory, version] = process.argv.slice(2);
assert.ok(directory && /^2\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-beta\.(?:0|[1-9]\d*)$/.test(version),
  'usage: verify-runtime-consumer.mjs <consumer-directory> <app-sdk-version>');
const name = '@bota.dev/react-native-app-sdk';
const root = resolve(directory);
const pkg = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
assert.equal(pkg.name, name);
assert.equal(pkg.version, version);
assert.deepEqual(pkg.dependencies, { buffer: '6.0.3', eventemitter3: '5.0.1' });
assert.equal(pkg.exports['./runtime'].default, './lib/commonjs/runtime.js');
assert.equal(pkg.exports['./runtime'].types, './lib/typescript/runtime.d.ts');
const require = createRequire(join(root, 'package.json'));
const previousLoad = Module._load, previousWasm = globalThis.WebAssembly, previousNative = globalThis.NativeModules;
Module._load = function(id, ...args) {
  assert.ok(!/^react-native(?:\/|$)|NativeBota/.test(id), `Native dependency in public runtime: ${id}`);
  return previousLoad.call(this, id, ...args);
};
globalThis.WebAssembly = undefined;
globalThis.NativeModules = new Proxy({}, { get() { throw Error('Native registry accessed'); } });
let runtime;
try {
  const { createBotaReactNativeJsRuntime, createBlePlxPort } = require(`${name}/runtime`);
  assert.equal(typeof createBlePlxPort, 'function');
  const journals = new Map();
  runtime = createBotaReactNativeJsRuntime({ apiVersion: 1, platform: 'ios',
    randomBytes: count => new Uint8Array(count).fill(0x42),
    persistence: { namespace: 'release-consumer/project/account/production',
      async load(key) { return journals.get(key) ?? null; },
      async save(key, value) { journals.set(key, value); }, async remove(key) { journals.delete(key); } },
    ble: { async scan() { return { async remove() {} }; }, async connect() {}, async discoverServices() {},
      async disconnect() {}, async read() { throw Error('Unexpected device read'); },
      async write() { throw Error('Unexpected device write'); }, async subscribe() { return { async remove() {} }; },
      async readBluetoothState() { return 'PoweredOn'; } },
  });
  await runtime.client.configure({ environment: 'production' });
  assert.equal(runtime.client.bluetoothState, 'poweredOn');
  await runtime.client.destroy(); runtime = undefined;
  console.log(`${name}/runtime@${version} constructs, configures and destroys its generated client without native imports or WebAssembly.`);
} finally {
  await runtime?.client.destroy();
  Module._load = previousLoad; globalThis.WebAssembly = previousWasm; globalThis.NativeModules = previousNative;
}
