import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = resolve(root, 'frameworks/react-native');
const consumer = process.argv[process.argv.indexOf('--consumer') + 1];
if (!process.argv.includes('--consumer') || !consumer) throw new Error('Pass --consumer PATH to an installed Expo app repository');
const require = createRequire(resolve(consumer, 'package.json'));
const expoRoot = resolve(require.resolve('expo-modules-autolinking/package.json'), '..');
const { scanDependenciesFromRNProjectConfig } = require(resolve(expoRoot, 'build/dependencies/rncliLocal.js'));
const { resolveReactNativeModule } = require(resolve(expoRoot, 'build/reactNativeConfig/reactNativeConfig.js'));
const work = realpathSync(mkdtempSync(join(tmpdir(), 'bota-wifi-package-')));
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work,
    '--cache', join(work, 'npm-cache')], { cwd: pkg, encoding: 'utf8' }))[0];
  execFileSync('tar', ['-xzf', join(work, packed.filename), '-C', work]);
  const unpacked = join(work, 'package');
  const entry = require(join(unpacked, 'native-io/react-native.config.cjs'));
  const project = { dependencies: { '@bota.dev/react-native-app-sdk': entry } };
  const resolutions = await scanDependenciesFromRNProjectConfig(work, project);
  const resolution = resolutions['@bota.dev/react-native-app-sdk'];
  assert.equal(resolution.path, join(unpacked, 'native-io'));
  const ios = await resolveReactNativeModule(resolution, project, 'ios', new Set());
  const android = await resolveReactNativeModule(resolution, project, 'android', new Set());
  assert.equal(ios.platforms.ios.podspecPath, join(entry.root, 'BotaLocalWifiTransport.podspec'));
  assert.equal(android.platforms.android.sourceDir, join(entry.root, 'android'));
  assert.equal(android.platforms.android.packageInstance, 'new BotaLocalWifiPackage()');
  assert.equal(android.platforms.android.libraryName, 'BotaDeviceSDKSpec');
  const manifest = JSON.parse(readFileSync(join(entry.root, 'generated/sources.json'), 'utf8'));
  for (const asset of manifest) {
    assert.deepEqual(readFileSync(join(entry.root, 'generated', asset.destination)), readFileSync(join(root, asset.source)));
  }
  const ordinary = { ...resolution, path: unpacked, originPath: unpacked };
  const full = await resolveReactNativeModule(ordinary, {}, 'ios', new Set());
  assert.equal(full.platforms.ios.podspecPath, join(unpacked, 'BotaDeviceSDK.podspec'));
  // Resolve the candidate's declared runtime dependencies from the installed
  // consumer, as an actual package install does, without editing its SDK pin.
  const appRequire = createRequire(resolve(consumer, 'app/package.json'));
  const installedSdkRequire = createRequire(appRequire.resolve('@bota.dev/react-native-app-sdk/package.json'));
  const candidateRequire = createRequire(join(unpacked, 'package.json'));
  for (const [name, version] of Object.entries(JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8')).dependencies)) {
    const dependency = installedSdkRequire.resolve(`${name}/package.json`);
    const destination = join(unpacked, 'node_modules', name);
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(dirname(dependency), destination, 'dir');
    assert.equal(candidateRequire(`${name}/package.json`).version, version);
  }
  const runtime = candidateRequire('./lib/commonjs/runtime.js');
  assert.equal(runtime.LOCAL_WIFI_CONTROL_PROFILE, 2);
  assert.equal(typeof runtime.createNativeLocalWifiPort, 'function');
  const appInstaller = resolve(consumer, 'app/lib/ble/localWifi.ts');
  if (existsSync(appInstaller)) {
    const ts = require('typescript');
    let retired = false, preflights = 0;
    const native = {
      async preflight() { preflights++; },
      async createLease() { throw new Error('No network lease expected'); },
      async join() {}, async open() {}, async read() {}, async closeReader() {}, async closeLease() {},
    };
    const code = ts.transpileModule(readFileSync(appInstaller, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const module = { exports: {} };
    new Function('require', 'module', 'exports', code)(name => {
      if (name === '@bota.dev/react-native-app-sdk/runtime') return runtime;
      if (name === 'react-native') return { Platform: { OS: 'ios' }, TurboModuleRegistry: { get: () => native } };
      throw new Error(`Unexpected App installer import: ${name}`);
    }, module, module.exports);
    const ble = {}, ports = { ble };
    module.exports.installLocalWifiPort(ports, async () => { if (retired) throw new Error('retired'); });
    assert.equal(module.exports.isLocalWifiAvailable(), true);
    assert.equal(ports.ble, ble);
    const context = { operation: 'TransferRecording', operationId: 'candidate', generation: '1',
      cancellationId: '1', requestId: '1', signal: new AbortController().signal };
    await ports.localWifi.preflight('device', context);
    assert.equal(preflights, 1);
    retired = true;
    await assert.rejects(ports.localWifi.preflight('device', context), /retired/);
    console.log('Packed runtime installs through Bota One source and preserves owner retirement and the existing BLE port.');
  }
  console.log('Packed npm payload: Expo iOS/Android select only local WiFi; default native entry remains unchanged.');
} finally { rmSync(work, { recursive: true, force: true }); }
