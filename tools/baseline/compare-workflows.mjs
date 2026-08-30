import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function validator(schema) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  });
  return ajv.compile(schema);
}

export function validateWorkflowSuite(suite, schema) {
  const validate = validator(schema);
  const errors = [];
  if (!validate(suite)) {
    errors.push(
      ...validate.errors.map(
        (error) =>
          `${suite.workflow ?? '<unknown>'}${error.instancePath}: ${error.message}`
      )
    );
  }

  const names = new Set();
  for (const scenario of suite.scenarios ?? []) {
    if (names.has(scenario.name)) {
      errors.push(`${suite.workflow}: duplicate scenario name ${scenario.name}`);
    }
    names.add(scenario.name);
  }
  return errors;
}

export function readWorkflowSuites(directory) {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json') && file !== 'schema.json')
    .sort()
    .map((file) => readJson(join(directory, file)));
}

export function validateWorkflowDirectory(directory) {
  const schema = readJson(join(directory, 'schema.json'));
  const suites = readWorkflowSuites(directory);
  const errors = [];
  const names = new Map();

  for (const suite of suites) {
    errors.push(...validateWorkflowSuite(suite, schema));
    const classifications = new Set(
      (suite.scenarios ?? []).map((scenario) => scenario.classification)
    );
    const missing = ['positive', 'rejection', 'cancellation', 'resume'].filter(
      (classification) => !classifications.has(classification)
    );
    if (missing.length) {
      errors.push(
        `${suite.workflow}: missing required classifications: ${missing.join(', ')}`
      );
    }
    for (const scenario of suite.scenarios ?? []) {
      const owner = names.get(scenario.name);
      if (owner) {
        errors.push(
          `${suite.workflow}: scenario name ${scenario.name} already used by ${owner}`
        );
      } else {
        names.set(scenario.name, suite.workflow);
      }
    }
  }
  return errors;
}

function readReferencedFile(root, relativePath, label, errors) {
  if (relativePath.startsWith('/') || relativePath.split('/').includes('..')) {
    errors.push(`${label}: reference must remain inside its repository`);
    return null;
  }
  const path = join(root, relativePath);
  if (!existsSync(path)) {
    errors.push(`${label}: referenced file not found: ${relativePath}`);
    return null;
  }
  return readFileSync(path, 'utf8');
}

export function validateWorkflowReferences(
  suites,
  { sdkPath, rustTestsPath }
) {
  const errors = [];
  for (const suite of suites) {
    for (const scenario of suite.scenarios) {
      const label = `${suite.workflow}/${scenario.name}`;
      const separator = scenario.sourceTest.indexOf('#');
      const sourcePath = scenario.sourceTest.slice(0, separator);
      const sourceAnchor = scenario.sourceTest.slice(separator + 1);
      const source = readReferencedFile(sdkPath, sourcePath, label, errors);
      if (source !== null && !source.includes(sourceAnchor)) {
        errors.push(`${label}: source anchor not found: ${sourceAnchor}`);
      }

      const [target, testName] = scenario.rustTest.split('::');
      const rust = readReferencedFile(
        rustTestsPath,
        `${target}.rs`,
        label,
        errors
      );
      const escapedName = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (rust !== null && !new RegExp(`\\bfn\\s+${escapedName}\\s*\\(`).test(rust)) {
        errors.push(`${label}: Rust test not found: ${scenario.rustTest}`);
      }
    }
  }
  return errors;
}

export function validateWorkflowCompatibility(suites, compatibility) {
  const required = ['positive', 'rejection', 'cancellation', 'resume'];
  const claims = new Map(
    (compatibility.workflows ?? []).map((claim) => [claim.workflow, claim])
  );
  const errors = [];

  for (const suite of suites) {
    const claim = claims.get(suite.workflow);
    if (!claim) {
      errors.push(`${suite.workflow}: compatibility claim is missing`);
      continue;
    }
    if (claim.scenarios !== suite.scenarios.length) {
      errors.push(
        `${suite.workflow}: compatibility scenario count ${claim.scenarios} does not match ${suite.scenarios.length}`
      );
    }
    const actual = new Set(
      suite.scenarios.map((scenario) => scenario.classification)
    );
    const declared = new Set(claim.classifications ?? []);
    const missing = required.filter(
      (classification) => !actual.has(classification) || !declared.has(classification)
    );
    if (claim.status === 'supported' && missing.length) {
      errors.push(
        `${suite.workflow}: cannot be supported without ${required.join(', ')}`
      );
    }
    claims.delete(suite.workflow);
  }
  for (const workflow of claims.keys()) {
    errors.push(`${workflow}: compatibility claim has no workflow suite`);
  }
  return errors;
}

function expectedTrace(workflow, scenario) {
  return {
    workflow,
    name: scenario.name,
    command: scenario.command,
    capabilities: scenario.capabilities,
    inputs: scenario.inputs,
    ...scenario.expected,
  };
}

export function compareWorkflowTraces(suites, traces) {
  const actual = new Map();
  for (const suite of traces) {
    for (const scenario of suite.scenarios ?? []) {
      actual.set(`${suite.workflow}/${scenario.name}`, {
        workflow: suite.workflow,
        ...scenario,
      });
    }
  }

  const errors = [];
  const expectedKeys = new Set();
  for (const suite of suites) {
    for (const scenario of suite.scenarios) {
      const key = `${suite.workflow}/${scenario.name}`;
      expectedKeys.add(key);
      if (!actual.has(key)) {
        errors.push(`${key}: Rust trace is missing`);
        continue;
      }
      if (!isDeepStrictEqual(actual.get(key), expectedTrace(suite.workflow, scenario))) {
        errors.push(`${key}: trace mismatch`);
      }
    }
  }
  for (const key of actual.keys()) {
    if (!expectedKeys.has(key)) errors.push(`${key}: undeclared Rust trace`);
  }
  return errors;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`
    );
  }
  return `${result.stdout}${result.stderr}`.trim();
}

function parseArguments(args) {
  const options = {
    workflowPath: 'protocol/workflows',
    sdkPath: null,
    allowDirty: false,
    runRustTests: true,
  };
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case '--workflows':
        options.workflowPath = args[++index];
        break;
      case '--sdk-path':
        options.sdkPath = args[++index];
        break;
      case '--allow-dirty':
        options.allowDirty = true;
        break;
      case '--skip-rust-tests':
        options.runRustTests = false;
        break;
      default:
        throw new Error(`unknown argument ${args[index]}`);
    }
  }
  if (!options.sdkPath) {
    options.sdkPath = process.env.BOTA_REACT_NATIVE_SDK_PATH ?? [
      '../react-native-sdk',
      '../../react-native-sdk',
    ].find((candidate) => existsSync(join(candidate, 'package.json')));
  }
  if (!options.sdkPath) {
    throw new Error(
      'React Native baseline not found; pass --sdk-path or BOTA_REACT_NATIVE_SDK_PATH'
    );
  }
  return options;
}

export function verifyWorkflowEvidence(options) {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const workflowPath = resolve(repository, options.workflowPath);
  const sdkPath = resolve(repository, options.sdkPath);
  const suites = readWorkflowSuites(workflowPath);
  const errors = validateWorkflowDirectory(workflowPath);
  const compatibility = readJson(
    join(repository, 'protocol/compatibility/firmware-compatibility.json')
  );
  errors.push(...validateWorkflowCompatibility(suites, compatibility));

  const revisions = new Set(suites.map((suite) => suite.baseline.revision));
  const versions = new Set(suites.map((suite) => suite.baseline.version));
  const sourceRevision = run('git', ['rev-parse', 'HEAD'], sdkPath);
  const packageVersion = JSON.parse(readFileSync(join(sdkPath, 'package.json'))).version;
  if (revisions.size !== 1 || !revisions.has(sourceRevision)) {
    errors.push(`React Native revision ${sourceRevision} does not match workflow baseline`);
  }
  if (versions.size !== 1 || !versions.has(packageVersion)) {
    errors.push(`React Native version ${packageVersion} does not match workflow baseline`);
  }
  const dirty = run('git', ['status', '--porcelain'], sdkPath);
  if (dirty && !options.allowDirty) {
    errors.push(`React Native checkout is dirty:\n${dirty}`);
  }
  errors.push(
    ...validateWorkflowReferences(suites, {
      sdkPath,
      rustTestsPath: join(repository, 'core/device-sdk-core/tests'),
    })
  );
  if (errors.length) {
    throw new Error(`workflow evidence failed:\n${errors.join('\n')}`);
  }

  const rustTests = [...new Set(
    suites.flatMap((suite) => suite.scenarios.map((scenario) => scenario.rustTest))
  )].sort();
  if (options.runRustTests) {
    for (const rustTest of rustTests) {
      const [target, testName] = rustTest.split('::');
      run(
        'cargo',
        [
          'test',
          '-p',
          'bota-device-sdk-core',
          '--test',
          target,
          testName,
          '--',
          '--exact',
        ],
        repository
      );
    }
  }

  return {
    workflowSuites: suites.length,
    scenarios: suites.reduce((count, suite) => count + suite.scenarios.length, 0),
    rustTests: rustTests.length,
    reactNativeVersion: packageVersion,
    reactNativeRevision: sourceRevision,
    dirty: Boolean(dirty),
  };
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    console.log(JSON.stringify(verifyWorkflowEvidence(parseArguments(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
