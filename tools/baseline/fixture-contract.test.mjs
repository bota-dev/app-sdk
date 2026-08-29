import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readFileSync } from 'node:fs';

import {
  validateFixtureDirectory,
  validateFixtureSuite,
} from './fixture-contract.mjs';

const schema = JSON.parse(
  readFileSync('protocol/fixtures/schema/fixture-suite.schema.json', 'utf8')
);

const validSuite = () => ({
  schemaVersion: 1,
  protocolRevision: 'firmware-8b175a89374c',
  suite: 'contract-test',
  cases: [
    {
      name: 'valid-case',
      operation: 'identityBytes',
      inputHex: '00ff',
      expectedHex: '00ff',
    },
  ],
});

test('all committed fixture suites satisfy the fixture contract', () => {
  const errors = validateFixtureDirectory('protocol/fixtures');

  assert.deepEqual(errors, []);
});

test('rejects duplicate case names', () => {
  const suite = validSuite();
  suite.cases.push({ ...suite.cases[0] });

  assert.match(validateFixtureSuite(suite, schema).join('\n'), /duplicate case name/);
});

test('rejects odd-length hexadecimal input', () => {
  const suite = validSuite();
  suite.cases[0].inputHex = 'abc';

  assert.match(validateFixtureSuite(suite, schema).join('\n'), /must match pattern/);
});

test('rejects undocumented case fields', () => {
  const suite = validSuite();
  suite.cases[0].unexpected = true;

  assert.match(
    validateFixtureSuite(suite, schema).join('\n'),
    /must NOT have additional properties/
  );
});
