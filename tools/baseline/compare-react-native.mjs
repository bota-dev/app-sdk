import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateFixtureDirectory } from './fixture-contract.mjs';
import { verifyReactNativeApiContract } from './react-native-api-contract.mjs';

const require = createRequire(import.meta.url);

export function normalizeValue(value) {
  if (value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, normalizeValue(child)])
    );
  }
  return value;
}

export function fixtureDigest(directory) {
  const root = resolve(directory);
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.json')) files.push(path);
    }
  };
  visit(root);
  files.sort((left, right) => left.localeCompare(right));

  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function evaluateFixtureCase(fixtureCase, sdk) {
  const actual = executeOperation(fixtureCase, sdk);

  if ('expectedError' in fixtureCase) {
    if (!(actual instanceof Error)) {
      throw new assert.AssertionError({
        message: `${fixtureCase.name ?? fixtureCase.operation} did not throw`,
        expected: fixtureCase.expectedError,
        actual: normalizeValue(actual),
      });
    }
    assert.equal(actual.message, fixtureCase.expectedError);
    return;
  }
  if (actual instanceof Error) throw actual;

  if ('expectedHex' in fixtureCase) {
    assert.equal(normalizeValue(actual), fixtureCase.expectedHex);
    return;
  }
  assert.deepEqual(normalizeValue(actual), fixtureCase.expected);
}

function executeOperation(fixtureCase, sdk) {
  const input = Buffer.from(fixtureCase.inputHex ?? '', 'hex');
  const parsers = sdk.parsers ?? {};

  try {
    switch (fixtureCase.operation) {
      case 'parseDeviceStatus':
      case 'parseRecordingList':
      case 'parseTransferPacket':
      case 'parseTriggerDeviceUploadResponse':
      case 'parseConnectionSettings':
      case 'parseWiFiConfigResult':
        return parsers[fixtureCase.operation](input);
      case 'serializeConnectionSettings':
        return parsers.serializeConnectionSettings(fixtureCase.input);
      case 'createAckPacket':
        return parsers.createAckPacket(
          fixtureCase.input.ackType,
          fixtureCase.input.sequenceNumber
        );
      case 'createTransferCommand':
        return parsers.createTransferCommand(
          fixtureCase.input.command,
          fixtureCase.input.recordingUuid
        );
      case 'createWiFiGrantPacket':
        return parsers.createWiFiGrantPacket(fixtureCase.input.grantBlob);
      case 'createWiFiScanCommand':
        return parsers.createWiFiScanCommand();
      case 'constantByte': {
        const value = sdk.constants[fixtureCase.constant];
        if (!Number.isInteger(value)) {
          throw new Error(`missing numeric SDK constant ${fixtureCase.constant}`);
        }
        return Buffer.from([value]);
      }
      case 'identityBytes':
        return input;
      case 'decodeDeviceLogs': {
        const decoder = new sdk.DeviceLogDecoder();
        return fixtureCase.inputsHex.map((hex) =>
          decoder.push(Buffer.from(hex, 'hex'))
        );
      }
      case 'firmwareUploadStart': {
        const result = Buffer.alloc(5);
        result[0] = 0x08;
        result.writeUInt32LE(fixtureCase.input.size, 1);
        return result;
      }
      case 'firmwareDataPacket': {
        const header = Buffer.alloc(3);
        header[0] = 0x20;
        header.writeUInt16LE(fixtureCase.input.sequenceNumber, 1);
        return Buffer.concat([
          header,
          Buffer.from(fixtureCase.input.payloadHex, 'hex'),
        ]);
      }
      case 'firmwareWindowAck': {
        const result = Buffer.alloc(3);
        result[0] = 0x10;
        result.writeUInt16LE(fixtureCase.input.sequenceNumber, 1);
        return result;
      }
      case 'firmwareUploadVerify': {
        const result = Buffer.alloc(5);
        result[0] = 0x09;
        result.writeUInt32LE(fixtureCase.input.crc32, 1);
        return result;
      }
      case 'firmwareStatus':
        return Buffer.from([fixtureCase.input.command, fixtureCase.input.result]);
      default:
        throw new Error(`unsupported fixture operation ${fixtureCase.operation}`);
    }
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function runCommand(command, args, cwd) {
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
  return `${result.stdout}${result.stderr}`;
}

function commandOutput(command, args, cwd) {
  return runCommand(command, args, cwd).trim();
}

function sourceDigest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseArguments(args) {
  const options = {
    sdkPath: null,
    expectedCommit: null,
    expectedVersion: '0.0.65',
    fixtures: 'protocol/fixtures',
    apiContract: 'protocol/baseline/react-native-public-api-0.0.65.json',
    allowDirty: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case '--sdk-path':
        options.sdkPath = args[++index];
        break;
      case '--expected-commit':
        options.expectedCommit = args[++index];
        break;
      case '--expected-version':
        options.expectedVersion = args[++index];
        break;
      case '--fixtures':
        options.fixtures = args[++index];
        break;
      case '--api-contract':
        options.apiContract = args[++index];
        break;
      case '--allow-dirty':
        options.allowDirty = true;
        break;
      default:
        throw new Error(`unknown argument ${args[index]}`);
    }
  }
  if (!options.sdkPath || !options.expectedCommit) {
    throw new Error(
      'usage: compare-react-native --sdk-path <path> --expected-commit <sha> [--allow-dirty]'
    );
  }
  return options;
}

function parseJestCounts(output) {
  const suites = output.match(/Test Suites:\s+(\d+) passed/);
  const tests = output.match(/Tests:\s+(\d+) passed/);
  if (!suites || !tests) {
    throw new Error('cannot parse Jest suite and test counts');
  }
  return { suites: Number(suites[1]), tests: Number(tests[1]) };
}

export function compareReactNative(options) {
  const sdkPath = resolve(options.sdkPath);
  const fixturePath = resolve(options.fixtures);
  const sourceRevision = commandOutput('git', ['rev-parse', 'HEAD'], sdkPath);
  if (!sourceRevision.startsWith(options.expectedCommit)) {
    throw new Error(
      `SDK revision ${sourceRevision} does not match ${options.expectedCommit}`
    );
  }

  const dirtyBefore = commandOutput('git', ['status', '--porcelain'], sdkPath);
  if (dirtyBefore && !options.allowDirty) {
    throw new Error(`SDK checkout is dirty:\n${dirtyBefore}`);
  }

  const packageJson = JSON.parse(readFileSync(join(sdkPath, 'package.json')));
  if (packageJson.version !== options.expectedVersion) {
    throw new Error(
      `SDK version ${packageJson.version} does not match ${options.expectedVersion}`
    );
  }

  const apiContractVerifier =
    options.apiContractVerifier ?? verifyReactNativeApiContract;
  const publicApi = apiContractVerifier({
    sdkPath,
    contract: options.apiContract,
  });

  const fixtureErrors = validateFixtureDirectory(fixturePath);
  if (fixtureErrors.length) {
    throw new Error(`fixture contract failed:\n${fixtureErrors.join('\n')}`);
  }

  runCommand('npm', ['run', 'build'], sdkPath);
  const jestOutput = runCommand('npm', ['test', '--', '--runInBand'], sdkPath);
  const jest = parseJestCounts(jestOutput);
  const parsers = require(join(sdkPath, 'lib/commonjs/ble/parsers.js'));
  const constants = require(join(sdkPath, 'lib/commonjs/ble/constants.js'));
  const { DeviceLogDecoder } = require(
    join(sdkPath, 'lib/commonjs/ble/deviceLogs.js')
  );
  const sdk = { parsers, constants, DeviceLogDecoder };
  let cases = 0;

  for (const file of readdirSync(fixturePath)
    .filter((entry) => entry.endsWith('.json'))
    .sort()) {
    const suite = JSON.parse(readFileSync(join(fixturePath, file), 'utf8'));
    for (const fixtureCase of suite.cases) {
      try {
        evaluateFixtureCase(fixtureCase, sdk);
      } catch (error) {
        throw new Error(`${suite.suite}/${fixtureCase.name}: ${error.message}`);
      }
      cases += 1;
    }
  }

  const dirtyAfter = commandOutput('git', ['status', '--porcelain'], sdkPath);
  if (dirtyAfter !== dirtyBefore) {
    throw new Error(
      `SDK source changed during comparison\nbefore:\n${dirtyBefore}\nafter:\n${dirtyAfter}`
    );
  }

  const sourceFiles = [
    'src/ble/constants.ts',
    'src/ble/parsers.ts',
    'src/ble/deviceLogs.ts',
    'src/protocol/ProtocolHandler.ts',
  ];
  return {
    package: packageJson.name,
    packageVersion: packageJson.version,
    sourceRevision,
    dirty: Boolean(dirtyBefore),
    dirtyPaths: dirtyBefore ? dirtyBefore.split('\n') : [],
    fixtureDigest: fixtureDigest(fixturePath),
    fixtureCases: cases,
    jest,
    publicApi,
    sourceDigests: Object.fromEntries(
      sourceFiles.map((file) => [file, sourceDigest(join(sdkPath, file))])
    ),
  };
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    console.log(JSON.stringify(compareReactNative(options), null, 2));
  } catch (error) {
    console.error(`baseline: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
