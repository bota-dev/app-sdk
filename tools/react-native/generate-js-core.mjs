import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, readSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';
import { preserveJsFunctionBoundaries } from './preserve-js-function-boundaries.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'frameworks/react-native/src/jsHost/generated/core.ts');
const scratch = join(root, 'target/react-native-js');
const check = process.argv.includes('--check');
const provenanceOnly = process.argv.includes('--provenance-only');
const binaryen = JSON.parse(readFileSync(join(root, 'node_modules/binaryen/package.json'), 'utf8'));
if (binaryen.version !== '132.0.0') throw new Error('Expected locked Binaryen 132.0.0');
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
const inputs = [
  ...walk(join(root, 'core/device-sdk-core')).filter(path => /(?:\.rs|Cargo\.toml)$/.test(path)),
  ...walk(join(root, 'bindings/device-sdk-js')).filter(path => /(?:\.rs|Cargo\.toml)$/.test(path)),
  join(root, 'Cargo.toml'), join(root, 'Cargo.lock'), join(root, 'rust-toolchain.toml'), fileURLToPath(import.meta.url),
  join(root, 'package-lock.json'),
  join(root, 'tools/react-native/preserve-js-function-boundaries.mjs'),
].sort((a, b) => relative(root, a).replaceAll('\\', '/').localeCompare(relative(root, b).replaceAll('\\', '/'), 'en'));
const hash = createHash('sha256');
for (const path of inputs) {
  hash.update(relative(root, path).replaceAll('\\', '/') + '\0');
  hash.update(readFileSync(path, 'utf8').replaceAll('\r\n', '\n') + '\0');
}
hash.update('binaryen@132.0.0');
const sourceHash = hash.digest('hex');
if (provenanceOnly) {
  if (!readFileSync(output, 'utf8').includes(`export const GENERATED_CORE_SOURCE_SHA256 = '${sourceHash}';`)) {
    throw new Error('Generated RN core is stale. Run npm run react-native:generate-js-core.');
  }
  console.log(`Generated RN core source verified: ${sourceHash}`);
  process.exit(0);
}
mkdirSync(scratch, { recursive: true });
const env = {
  ...process.env,
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1',
  CARGO_PROFILE_RELEASE_OPT_LEVEL: 'z',
  CARGO_PROFILE_RELEASE_LTO: 'true',
  CARGO_PROFILE_RELEASE_PANIC: 'abort',
  CARGO_ENCODED_RUSTFLAGS: [
    '-C', 'target-feature=-reference-types,-multivalue,+bulk-memory',
    '-C', 'link-arg=--max-memory=33554432',
    '-C', 'link-arg=-zstack-size=524288',
    '--remap-path-prefix', `${root}=/bota-app-sdk`,
    '--remap-path-prefix', `${process.env.CARGO_HOME ?? join(homedir(), '.cargo')}=/cargo`,
  ].join('\x1f'),
};
execFileSync('cargo', ['build', '--locked', '--release', '--lib', '--target', 'wasm32-unknown-unknown', '-p', 'bota-device-sdk-js'],
  { cwd: root, env, stdio: 'inherit' });
const wasm = join(root, 'target/wasm32-unknown-unknown/release/bota_device_sdk_js.wasm');
const lowered = join(scratch, 'core.lowered.wasm');
// Lower saturating f64-to-i64 casts before wasm2js's i64 legalization. Keep the
// feature disabled during its optimizer so it cannot introduce unsupported casts.
const binaryenRun = (tool, arguments_) => {
  const log = join(scratch, `${tool}.log`), descriptor = openSync(log, 'w');
  try {
    execFileSync(process.execPath, [join(root, `node_modules/binaryen/bin/${tool}`), ...arguments_],
      { cwd: root, stdio: ['ignore', descriptor, descriptor] });
  } catch {
    const input = openSync(log, 'r'), prefix = Buffer.alloc(2048);
    const count = readSync(input, prefix, 0, prefix.length, 0); closeSync(input);
    throw new Error(`${tool} failed; diagnostics retained at ${relative(root, log)}\n${prefix.subarray(0, count)}`);
  } finally { closeSync(descriptor); }
};
binaryenRun('wasm-opt', [wasm, '-Oz', '--strip-debug', '--strip-producers', '--enable-bulk-memory',
  '--one-caller-inline-max-function-size=1024', '--llvm-nontrapping-fptoint-lowering',
  '--disable-nontrapping-float-to-int', '-o', lowered]);
const generated = join(scratch, 'core.mjs');
binaryenRun('wasm2js', [lowered, '-O', '--pedantic', '--enable-bulk-memory',
  '--one-caller-inline-max-function-size=1024', '--disable-nontrapping-float-to-int', '-o', generated]);
const source = readFileSync(generated, 'utf8').replaceAll('\r\n', '\n');
const boundary = source.indexOf('\nvar retasmFunc = asmFunc(');
if (boundary < 0 || !source.includes('\nfunction asmFunc(imports) {')) {
  throw new Error('Unexpected wasm2js module format');
}
// Only the isolated function is retained. Each factory owns its own memory and registries.
const body = source.slice(0, boundary);
if (/\b(?:WebAssembly|require|import)\s*(?:\.|\(|\{)/.test(body)) throw new Error('Generated core has a runtime dependency');
const exports = [...source.matchAll(/^export var (\w+) = retasmFunc\./gm)].map(match => match[1]);
const expected = ['memory', 'bota_js_abi_version', 'bota_js_buffer_alloc', 'bota_js_buffer_ptr',
  'bota_js_buffer_len', 'bota_js_buffer_free', 'bota_js_engine_new', 'bota_js_engine_free', 'bota_js_rpc'];
if (expected.some(name => !exports.includes(name)) || exports.some(name => !expected.includes(name))) {
  throw new Error(`Unexpected JS bridge exports: ${exports.join(', ')}`);
}
const boundedBody = preserveJsFunctionBoundaries(body);
const compact = await minify(`${boundedBody}\nfunction instantiateCompiledCore(){ return asmFunc({}); }`, {
  compress: false, mangle: { reserved: ['instantiateCompiledCore'] },
  format: { comments: false, ascii_only: true, max_line_len: 4096 },
});
if (!compact.code) throw new Error('Generated JS minification produced no code');
const result = `// @ts-nocheck\n// Generated from shared Rust by tools/react-native/generate-js-core.mjs. Do not edit.\n` +
  `// Rust 1.98.0 / Binaryen 132.0.0; runtime uses ordinary JS and typed arrays.\n` +
  `export const GENERATED_CORE_SOURCE_SHA256 = '${sourceHash}';\n` +
  `export interface GeneratedCoreExports {\n  memory: { readonly buffer: ArrayBuffer };\n` +
  expected.filter(name => name !== 'memory').map(name => `  ${name}(...args: number[]): number;`).join('\n') +
  `\n}\nexport function instantiateGeneratedCore(): GeneratedCoreExports {\n` +
  // The entire data prelude is inside this factory, including wasm2js's bufferView.
  `${compact.code}\nreturn instantiateCompiledCore();\n}\n`;
mkdirSync(dirname(output), { recursive: true });
if (check) {
  if (readFileSync(output, 'utf8').replaceAll('\r\n', '\n') !== result) throw new Error('Committed generated RN core differs from exact-source rebuild');
  console.log(`Generated RN core rebuilt and verified (${result.length} bytes).`);
} else {
  writeFileSync(output, result);
  console.log(`Generated RN executable JavaScript core (${result.length} bytes).`);
}
