import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

const schemaPath = 'protocol/vectors/encrypted-upload-v2.schema.json';
const bundlePath = 'protocol/vectors/encrypted-upload-v2.json';

const load = () => ({
  schema: JSON.parse(readFileSync(schemaPath, 'utf8')),
  bundle: JSON.parse(readFileSync(bundlePath, 'utf8')),
});

const compile = (schema) => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(schema);
};

test('encrypted upload v2 bundle satisfies the closed canonical schema', () => {
  const { schema, bundle } = load();
  const validate = compile(schema);
  assert.equal(validate(bundle), true, JSON.stringify(validate.errors));
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.contractRevision, 'encrypted-upload-v2-contract-v1');
  assert.equal(bundle.generatedBy, 'cargo xtask encrypted-upload-v2 vectors generate');
  assert.ok(bundle.cases.length >= 40);
});

test('schema rejects uppercase, odd-length, and dual-result vector cases', () => {
  const { schema, bundle } = load();
  const validate = compile(schema);
  const base = structuredClone(bundle);
  const caseIndex = base.cases.findIndex(({ inputHex }) => inputHex.length >= 2);
  assert.notEqual(caseIndex, -1);

  const uppercase = structuredClone(base);
  uppercase.cases[caseIndex].inputHex = 'AA';
  assert.equal(validate(uppercase), false);

  const odd = structuredClone(base);
  odd.cases[caseIndex].inputHex = 'a';
  assert.equal(validate(odd), false);

  const dual = structuredClone(base);
  const dualCase = dual.cases.find(({ expected }) => expected !== undefined);
  dualCase.expectedError = 'invalid_length';
  assert.equal(validate(dual), false);
});
