import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

export function validateFixtureSuite(suite, schema) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  });
  const validate = ajv.compile(schema);
  const errors = [];

  if (!validate(suite)) {
    errors.push(
      ...validate.errors.map(
        (error) =>
          `${suite.suite ?? '<unknown>'}${error.instancePath}: ${error.message}`
      )
    );
  }

  const seen = new Set();
  for (const fixtureCase of suite.cases ?? []) {
    if (seen.has(fixtureCase.name)) {
      errors.push(`${suite.suite}: duplicate case name ${fixtureCase.name}`);
    }
    seen.add(fixtureCase.name);
  }

  return errors;
}

export function validateFixtureDirectory(directory) {
  const schema = readJson(join(directory, 'schema/fixture-suite.schema.json'));
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort();
  const errors = [];
  const caseNames = new Map();

  for (const file of files) {
    const suite = readJson(join(directory, file));
    errors.push(...validateFixtureSuite(suite, schema));
    for (const fixtureCase of suite.cases ?? []) {
      const existing = caseNames.get(fixtureCase.name);
      if (existing) {
        errors.push(
          `${suite.suite}: case name ${fixtureCase.name} already used by ${existing}`
        );
      } else {
        caseNames.set(fixtureCase.name, suite.suite);
      }
    }
  }

  return errors;
}
