import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { runByoConformance } from '../react-native/byo-conformance.mjs';
import { runManagedRouteConformance } from '../react-native/managed-route-conformance.mjs';
import { runBoundModelConformance } from '../react-native/bound-model-conformance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const expectedCommit = '829dcd74f5b774d19a86ab1dc47e3dee9e44d190';
const output = join(root, 'target/hermes-conformance');
const args = process.argv.slice(2);
let mode = 'runtime';
let hermesBin = process.env.HERMES_BIN;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--bundle-only' || args[index] === '--compile-only') {
    if (mode !== 'runtime') throw new Error('Choose exactly one conformance mode.');
    mode = args[index] === '--bundle-only' ? 'bundle' : 'compile';
  } else if (args[index] === '--hermes-bin') {
    hermesBin = args[++index];
    if (!hermesBin || hermesBin.startsWith('--')) throw new Error('--hermes-bin needs a path.');
  } else {
    throw new Error(`Unknown conformance option: ${args[index]}`);
  }
}
if (mode !== 'bundle' && !hermesBin) throw new Error('Set HERMES_BIN or pass --hermes-bin.');

const source = readFileSync(join(root, 'frameworks/react-native/src/jsHost/generated/core.ts'), 'utf8');
const sourceHash = source.match(/GENERATED_CORE_SOURCE_SHA256 = '([0-9a-f]{64})'/)?.[1];
assert.ok(sourceHash, 'Committed generated core must contain source provenance.');
const compiled = ts.transpileModule(source, {
  fileName: 'generated-core.ts', reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2015, module: ts.ModuleKind.CommonJS, removeComments: true },
});
for (const diagnostic of compiled.diagnostics ?? []) {
  if (diagnostic.category === ts.DiagnosticCategory.Error) {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  }
}
assert.ok(!/\b(?:require\s*\(|import\s*(?:\(|["'{])|WebAssembly\s*[.\[])/.test(compiled.outputText),
  'The generated core bundle must have no native imports or WebAssembly runtime.');
const fixtures = {
  ota: JSON.parse(readFileSync(join(root, 'protocol/fixtures/ota.json'), 'utf8')),
  status: JSON.parse(readFileSync(join(root, 'protocol/fixtures/device-status.json'), 'utf8')),
  transfer: JSON.parse(readFileSync(join(root, 'protocol/fixtures/transfer-control.json'), 'utf8')),
};
// Exercise one ordinary Metro-style module factory. Do not raise the compiler's
// parser limit or flatten away wrapping required by a consuming RN bundle.
const bundle = `'use strict';\nvar generatedModule = { exports: {} };\n` +
  `(function(global, require, module, exports) {\n${compiled.outputText}\n})(this, undefined, generatedModule, generatedModule.exports);\n` +
  `var generated = generatedModule.exports;\n` +
  `var fixtures = ${JSON.stringify(fixtures)};\n` +
  `var runByoConformance = ${runByoConformance.toString()};\n` +
  `var runManagedRouteConformance = ${runManagedRouteConformance.toString()};\n` +
  `var runBoundModelConformance = ${runBoundModelConformance.toString()};\n` +
  `(${runConformance.toString()})(generated, fixtures);\n`;
mkdirSync(output, { recursive: true });
const bundlePath = join(output, 'core-conformance.js');
writeFileSync(bundlePath, bundle);
const lines = [];
vm.runInNewContext(bundle, {
  print: line => lines.push(String(line)), WebAssembly: undefined,
  require: undefined, Buffer: undefined, TextEncoder: undefined, TextDecoder: undefined,
}, { filename: bundlePath, timeout: 90_000 });
const expected = parseTranscript(lines.join('\n'));
assert.ok(expected.checks >= 20, 'The standalone bundle must execute the full conformance trace.');
writeFileSync(join(output, 'node-result.json'), JSON.stringify(expected, null, 2) + '\n');
const bundleSha256 = createHash('sha256').update(bundle).digest('hex');
if (mode === 'bundle') {
  console.log(`Node VM passed ${expected.checks} standalone checks; Hermes execution was not requested. Bundle: ${bundlePath}`);
  process.exit(0);
}

const binaryPath = resolve(hermesBin);
const version = runBinary(['--version']).stdout.trim();
const binarySha256 = createHash('sha256').update(readFileSync(binaryPath)).digest('hex');
if (mode === 'compile') {
  runBinary(['-O', '-emit-binary', '-out', join(output, 'core-conformance.hbc'), bundlePath]);
  writeFileSync(join(output, 'compile-result.json'), JSON.stringify({
    schemaVersion: 1, proof: 'bytecode-compilation-only', sourceHash, bundleSha256,
    binarySha256, version, checksExecutedInNode: expected.checks,
  }, null, 2) + '\n');
  console.log(`Hermes bytecode compilation passed; ${expected.checks} Node checks passed. Hermes VM execution remains unverified.`);
  process.exit(0);
}

const build = JSON.parse(readFileSync(`${binaryPath}.build-info.json`, 'utf8'));
assert.equal(build.schemaVersion, 1);
assert.equal(build.sourceCommit, expectedCommit, 'Runtime must use the pinned React Native Hermes source.');
assert.equal(build.sourceRepository, 'https://github.com/facebook/hermes.git');
assert.equal(build.sourceTag, 'hermes-v0.17.0');
assert.equal(build.binarySha256, binarySha256, 'Hermes executable differs from its build provenance.');
assert.deepEqual(build.configuration, { buildType: 'Release', debugger: false, intl: false, target: 'hermes' });
const actual = parseTranscript(runBinary(['-O', '-exec', bundlePath]).stdout);
assert.deepEqual(actual, expected, 'Hermes runtime and Node VM produced different core conformance results.');
writeFileSync(join(output, 'runtime-result.json'), JSON.stringify({
  schemaVersion: 1, proof: 'pinned-hermes-runtime-and-node-conformance',
  sourceCommit: expectedCommit, sourceHash, bundleSha256, binarySha256, version,
  checks: actual.checks, transcript: actual.transcript,
}, null, 2) + '\n');
console.log(`Pinned Hermes 0.17 VM and Node agree on ${actual.checks} standalone generated-core checks.`);

function runBinary(arguments_) {
  const result = spawnSync(binaryPath, arguments_, {
    cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${binaryPath} ${arguments_.join(' ')} failed:\n${result.stderr}\n${result.stdout}`);
  return result;
}

function parseTranscript(stdout) {
  const records = stdout.split(/\r?\n/).filter(line => line.startsWith('BOTA_HERMES_RESULT='));
  assert.equal(records.length, 1, 'The conformance runner must emit exactly one complete result.');
  return JSON.parse(records[0].slice('BOTA_HERMES_RESULT='.length));
}

// This function is embedded verbatim in the standalone bundle. It deliberately
// uses only JavaScript/typed-array globals available in Node and Hermes.
function runConformance(generated, fixtures) {
  var checks = 0;
  var transcript = [];
  function check(condition, message) {
    if (!condition) throw new Error(message);
    checks++;
  }
  function same(actual, expected, message) {
    function canonical(value) {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === 'object') {
        var result = {};
        Object.keys(value).sort().forEach(function (key) { result[key] = canonical(value[key]); });
        return result;
      }
      return value;
    }
    check(JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected)), message);
  }
  function utf8Encode(text) {
    var bytes = [];
    for (var index = 0; index < text.length; index++) {
      var point = text.charCodeAt(index);
      if (point >= 0xd800 && point <= 0xdbff) {
        var low = text.charCodeAt(++index);
        check(low >= 0xdc00 && low <= 0xdfff, 'Invalid UTF-16 surrogate pair');
        point = 0x10000 + ((point - 0xd800) << 10) + low - 0xdc00;
      } else if (point >= 0xdc00 && point <= 0xdfff) throw new Error('Unexpected low surrogate');
      if (point < 0x80) bytes.push(point);
      else if (point < 0x800) bytes.push(0xc0 | point >> 6, 0x80 | point & 63);
      else if (point < 0x10000) bytes.push(0xe0 | point >> 12, 0x80 | point >> 6 & 63, 0x80 | point & 63);
      else bytes.push(0xf0 | point >> 18, 0x80 | point >> 12 & 63, 0x80 | point >> 6 & 63, 0x80 | point & 63);
    }
    return new Uint8Array(bytes);
  }
  function utf8Decode(bytes) {
    var text = '';
    for (var index = 0; index < bytes.length;) {
      var first = bytes[index++];
      var count = first < 0x80 ? 0 : first >= 0xc2 && first <= 0xdf ? 1 : first >= 0xe0 && first <= 0xef ? 2 : first >= 0xf0 && first <= 0xf4 ? 3 : -1;
      if (count < 0 || index + count > bytes.length) throw new Error('Invalid UTF-8 prefix');
      var point = first & (count === 0 ? 127 : count === 1 ? 31 : count === 2 ? 15 : 7);
      for (var tail = 0; tail < count; tail++) {
        var next = bytes[index++];
        if ((next & 0xc0) !== 0x80) throw new Error('Invalid UTF-8 continuation');
        point = point << 6 | next & 63;
      }
      if ((count === 1 && point < 0x80) || (count === 2 && point < 0x800)
        || (count === 3 && point < 0x10000) || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new Error('Invalid UTF-8 code point');
      if (point <= 0xffff) text += String.fromCharCode(point);
      else { point -= 0x10000; text += String.fromCharCode(0xd800 | point >> 10, 0xdc00 | point & 1023); }
    }
    return text;
  }
  function unhex(text) {
    var bytes = [];
    for (var index = 0; index < text.length; index += 2) bytes.push(parseInt(text.slice(index, index + 2), 16));
    return bytes;
  }
  function hex(bytes) {
    return bytes.map(function (byte) { return ('0' + byte.toString(16)).slice(-2); }).join('');
  }
  check(typeof WebAssembly === 'undefined', 'Conformance must execute without WebAssembly');
  check(typeof require === 'undefined' && typeof Buffer === 'undefined', 'Conformance must execute without native/module globals');
  same(utf8Decode(utf8Encode('Bota 中 \ud83d\udcce')), 'Bota 中 \ud83d\udcce', 'UTF-8 helper lost non-ASCII code points');
  var core = generated.instantiateGeneratedCore();
  check(core.bota_js_abi_version() === 1, 'Unexpected core ABI');
  var engine = core.bota_js_engine_new() >>> 0;
  check(engine !== 0, 'Core engine allocation failed');
  function rpc(input) {
    var encoded = utf8Encode(JSON.stringify(input));
    var request = core.bota_js_buffer_alloc(encoded.length) >>> 0;
    check(request !== 0, 'RPC input allocation failed');
    var response = 0;
    try {
      var requestLength = core.bota_js_buffer_len(request) >>> 0;
      var requestPointer = core.bota_js_buffer_ptr(request) >>> 0;
      var memory = core.memory.buffer;
      check(requestLength === encoded.length && requestPointer <= memory.byteLength - requestLength, 'Invalid input buffer bounds');
      new Uint8Array(memory, requestPointer, requestLength).set(encoded);
      response = core.bota_js_rpc(engine, request) >>> 0;
      check(response !== 0, 'RPC response allocation failed');
      var length = core.bota_js_buffer_len(response) >>> 0;
      var pointer = core.bota_js_buffer_ptr(response) >>> 0;
      memory = core.memory.buffer;
      check(length > 0 && length <= 1024 * 1024 && pointer <= memory.byteLength - length, 'Invalid response buffer bounds');
      var result = JSON.parse(utf8Decode(new Uint8Array(memory, pointer, length)));
      transcript.push({ input: input, output: result });
      return result;
    } finally {
      if (response) core.bota_js_buffer_free(response);
      core.bota_js_buffer_free(request);
      encoded.fill(0);
    }
  }
  function codec(name, input) {
    return rpc({ version: 1, action: 'codec', codec: name, input: input });
  }
  function success(response, label) {
    check(response.ok === true, label + ' rejected');
    return response.result;
  }
  try {
    same(success(rpc({ version: 1, action: 'status' }), 'Idle status').status, 'Idle', 'New engine must be Idle');
    same(success(codec('protocolMetadata', {}), 'Protocol metadata').SERVICE_DEVICE_INFO, '180A', 'Canonical service metadata');
    same(success(codec('encodeAck', { ack_type: 'ack', sequence: 65535 }), 'ACK'), [16, 255, 255], 'Canonical maximum-sequence ACK bytes');
    fixtures.transfer.cases.forEach(function (fixture) {
      if (fixture.operation === 'createAckPacket') same(hex(success(codec('encodeAck', {
        ack_type: fixture.input.ackType, sequence: fixture.input.sequenceNumber,
      }), fixture.name)), fixture.expectedHex, fixture.name + ' golden bytes');
    });
    same(success(codec('decodeText', { bytes: [0xe4, 0xb8, 0xad, 0xf0, 0x9f, 0x93, 0x8e], required: true }), 'Unicode device text'), '中\ud83d\udcce', 'UTF-8 RPC response');
    runByoConformance(codec, success, check, same, utf8Encode);
    runManagedRouteConformance(codec, success, check, same);
    runBoundModelConformance(codec, success, check, same);
    fixtures.ota.cases.forEach(function (fixture) {
      var input = fixture.input;
      var name;
      if (fixture.operation === 'firmwareUploadStart') name = 'encodeFirmwareUploadStart';
      else if (fixture.operation === 'firmwareDataPacket') { name = 'encodeFirmwareData'; input = { sequence: input.sequenceNumber, payload: unhex(input.payloadHex) }; }
      else if (fixture.operation === 'firmwareWindowAck') { name = 'encodeFirmwareWindowAck'; input = { sequence: input.sequenceNumber }; }
      else if (fixture.operation === 'firmwareUploadVerify') name = 'encodeFirmwareVerify';
      if (name) same(hex(success(codec(name, input), fixture.name)), fixture.expectedHex, fixture.name + ' golden bytes');
    });
    fixtures.status.cases.forEach(function (fixture) {
      var response = codec('decodeDeviceStatus', { bytes: unhex(fixture.inputHex) });
      if (fixture.expectedError) { check(response.ok === false, 'Truncated golden status must reject'); return; }
      var result = success(response, fixture.name);
      Object.keys(fixture.expected).forEach(function (key) {
        if (key === 'lastTimeSyncAt') {
          same(result.lastTimeSyncAtMs || null, fixture.expected[key] ? Date.parse(fixture.expected[key]) : null, fixture.name + ' canonical timestamp milliseconds');
        } else same(result[key], fixture.expected[key], fixture.name + ' ' + key);
      });
    });
    var cancellation = [];
    for (var index = 0; index < 16; index++) cancellation.push(index + 1);
    var owner = { generation: '9007199254740993', operation: 'Discover', cancellation_id: cancellation };
    var start = { version: 1, action: 'start', generation: owner.generation, operation: owner.operation,
      cancellation_id: owner.cancellation_id, capabilities: ['Ble', 'Timer'],
      command: { DiscoverDevices: { timeout_ms: '100', allow_duplicates: false } } };
    var started = success(rpc(start), 'Discover start');
    same(started.generation, owner.generation, 'Workflow generation must retain exact u64 precision');
    same(started.status.Running.operation, 'Discover', 'Discover workflow is Running');
    var timer = started.effects.filter(function (effect) { return effect.effect.Timer && effect.effect.Timer.Schedule; })[0];
    check(Boolean(timer), 'Discover must schedule a timer');
    var wrongCancellation = cancellation.slice(); wrongCancellation[0] ^= 1;
    check(rpc({ version: 1, action: 'cancel', generation: owner.generation, operation: owner.operation, cancellation_id: wrongCancellation }).ok === false, 'Foreign cancellation must reject');
    check(rpc({ version: 1, action: 'cancel', generation: '9007199254740992', operation: owner.operation, cancellation_id: cancellation }).ok === false, 'Stale u64 generation must reject');
    check(rpc({ version: 1, action: 'cancel', generation: owner.generation, operation: 'Connect', cancellation_id: cancellation }).ok === false, 'Foreign operation must reject');
    check(rpc({ version: 1, action: 'dispatch', generation: owner.generation, operation: owner.operation,
      cancellation_id: cancellation, event: { request_id: timer.request_id, kind: { Ble: 'WriteCompleted' } } }).ok === false, 'Foreign callback family must reject');
    check(rpc({ version: 1, action: 'dispatch', generation: owner.generation, operation: owner.operation,
      cancellation_id: cancellation, event: { request_id: '18446744073709551615',
        kind: { TimerFired: { timer_id: timer.effect.Timer.Schedule.timer_id } } } }).ok === false, 'Unknown exact u64 request identity must reject');
    success(rpc({ version: 1, action: 'cancel', generation: owner.generation, operation: owner.operation, cancellation_id: cancellation }), 'Exact cancellation');
    check(rpc(start).ok === false, 'Retired workflow generation cannot restart');
    check(rpc({ version: 1, action: 'codec', codec: 'protocolMetadata', input: {}, generation: owner.generation }).ok === false, 'Codec calls cannot carry workflow authority');
    var maximumGeneration = '18446744073709551615';
    check(rpc({ version: 1, action: 'start', generation: maximumGeneration, cancellation_id: cancellation,
      capabilities: ['Ble', 'Timer', 'Persistence'], command: { Connect: { device: 'bad serial!',
        candidate: { peripheral_id: 'probe', name: null, advertised_address: null, rssi: -60 } } } }).ok === false,
      'Invalid device identity must reject before starting a workflow');
    start.generation = maximumGeneration;
    same(success(rpc(start), 'Maximum generation start').generation, maximumGeneration, 'Maximum u64 generation must survive the raw bridge');
    check(rpc({ version: 1, action: 'cancel', generation: '18446744073709551616', operation: owner.operation, cancellation_id: cancellation }).ok === false,
      'Out-of-range u64 generation must reject');
    success(rpc({ version: 1, action: 'cancel', generation: maximumGeneration, operation: owner.operation, cancellation_id: cancellation }), 'Maximum-generation exact cancellation');
    check(core.bota_js_engine_free(engine) === 0, 'Core engine release failed');
    check(core.bota_js_engine_free(engine) !== 0, 'Stale engine release must reject');
    engine = 0;
    print('BOTA_HERMES_RESULT=' + JSON.stringify({ checks: checks, transcript: transcript }));
  } finally { if (engine) core.bota_js_engine_free(engine); }
}
