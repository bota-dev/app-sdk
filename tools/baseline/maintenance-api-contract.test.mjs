import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from './react-native-api-contract.mjs';

const member = (name, type, optional = false) => ({
  name, type, optional, readonly: false, declarationKinds: ['PropertySignature'],
});
const exported = (name, members = []) => ({
  name, runtime: false, declarationKinds: ['InterfaceDeclaration'],
  callSignatures: [], constructSignatures: [], members, staticMembers: [], declaredType: name,
});
const fixture = () => {
  const frozen = { exports: [exported('Config', [member('timeout', 'number')])] };
  const additions = {
    exports: [exported('Recovery', [member('id', 'string')])],
    members: { Config: [member('recovery', 'Recovery | undefined', true)] },
    constructSignatures: {},
  };
  const surface = structuredClone(frozen);
  surface.exports[0].members.push(...structuredClone(additions.members.Config));
  surface.exports.push(...structuredClone(additions.exports));
  return { frozen, additions, surface };
};
const check = (input) => {
  assert.equal(typeof api.validateCompatibleReactNativeSurface, 'function');
  return api.validateCompatibleReactNativeSurface(input);
};

test('accepts only the enumerated additions without mutating the frozen contract', () => {
  const input = fixture();
  const before = structuredClone(input);
  assert.deepEqual(check(input), []);
  assert.deepEqual(input, before);
});

test('rejects removal, signature drift, optionality drift and unlisted members', () => {
  for (const change of [
    (entry) => entry.members.shift(),
    (entry) => { entry.members[0].type = 'any'; },
    (entry) => { entry.members[0].optional = true; },
    (entry) => entry.members.push(member('unchecked', 'string', true)),
    (entry) => entry.staticMembers.push(member('unchecked', 'string')),
  ]) {
    const input = fixture();
    change(input.surface.exports[0]);
    assert.match(check(input).join('\n'), /Config/);
  }
});

test('rejects missing maintenance exports and changed recovery property signatures', () => {
  const input = fixture();
  input.surface.exports.pop();
  assert.match(check(input).join('\n'), /Recovery/);
  input.surface.exports[0].members[1].type = 'unknown';
  assert.match(check(input).join('\n'), /Config/);
});

test('an allowlist cannot overwrite a frozen member or add a required property', () => {
  const input = fixture();
  input.additions.members.Config.push(member('timeout', 'any'));
  assert.match(check(input).join('\n'), /frozen member/);
  input.additions.members.Config.pop();
  input.additions.members.Config[0].optional = false;
  assert.match(check(input).join('\n'), /optional property or method/);
});

test('requires the old zero-argument constructor even when new options are optional', () => {
  const input = fixture();
  input.frozen.exports[0].constructSignatures = ['() => Config'];
  input.additions.constructSignatures.Config = ['(options?: Recovery) => Config'];
  input.surface.exports[0].constructSignatures = ['(options?: Recovery) => Config'];
  assert.match(check(input).join('\n'), /Config/);
  input.surface.exports[0].constructSignatures.push('() => Config');
  assert.deepEqual(check(input), []);
});

test('normalizes literal union order only, not member or parameter types', () => {
  const input = fixture();
  input.frozen.exports[0].members[0].type = '"a" | "b"';
  input.surface.exports[0].members[0].type = '"b" | "a"';
  assert.deepEqual(check(input), []);
  input.surface.exports[0].members[0].type = '"b" | "a" | "c"';
  assert.match(check(input).join('\n'), /Config/);
});

test('maintenance selection must match the contract, workflow pin, and explicit audit revision', () => {
  assert.equal(typeof api.validateMaintenanceSelection, 'function');
  const contract = { packageVersion: '0.0.67', sourceRevision: '3'.repeat(40) };
  const compatibility = {
    reactNativeMaintenanceBaseline: { version: '0.0.67', revision: contract.sourceRevision },
    reactNativeWorkflowBaseline: { version: '0.0.67', revision: contract.sourceRevision },
  };
  const checkSelection = (expectedRevision = contract.sourceRevision) =>
    api.validateMaintenanceSelection({ contract, compatibility, expectedRevision });
  assert.deepEqual(checkSelection(), []);
  assert.match(checkSelection('4'.repeat(40)).join('\n'), /explicit audit revision/);
  compatibility.reactNativeWorkflowBaseline.revision = 'e'.repeat(40);
  assert.match(checkSelection().join('\n'), /workflow/);
  delete compatibility.reactNativeMaintenanceBaseline;
  assert.match(checkSelection().join('\n'), /maintenance/);
});

test('source digest, dependency lock and compiler drift cannot pass as a maintenance match', () => {
  assert.equal(typeof api.validateMaintenanceSource, 'function');
  const source = { package: '@bota.dev/react-native-sdk', packageVersion: '0.0.67',
    sourceRevision: '3'.repeat(40), surfaceDigest: 'a'.repeat(64) };
  const contract = { ...source, toolchain: { nodeMajor: 22, typescript: '6.0.3',
    sourceLockDigest: 'b'.repeat(64) } };
  const checkSource = (overrides = {}) => api.validateMaintenanceSource({ contract,
    source, toolchain: contract.toolchain, ...overrides });
  assert.deepEqual(checkSource(), []);
  assert.match(checkSource({ source: { ...source, surfaceDigest: 'c'.repeat(64) } }).join('\n'), /surfaceDigest/);
  assert.match(checkSource({ source: { ...source, sourceRevision: 'e'.repeat(40) } }).join('\n'), /sourceRevision/);
  assert.match(checkSource({ toolchain: { ...contract.toolchain, sourceLockDigest: 'c'.repeat(64) } }).join('\n'), /toolchain/);
  assert.match(checkSource({ toolchain: { ...contract.toolchain, typescript: '7.0.0' } }).join('\n'), /toolchain/);
});
