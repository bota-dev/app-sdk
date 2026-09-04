#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_PATH = 'frameworks/flutter/bota_flutter_sdk';
const REQUIRED_FILES = [
  'LICENSE',
  'analysis_options.yaml',
  'android/src/main/kotlin/dev/bota/sdk/flutter/BotaApi.g.kt',
  'ios/Classes/BotaApi.g.swift',
  'lib/bota_flutter_sdk.dart',
  'lib/src/generated/bota_api.g.dart',
  'pigeon_options.yaml',
  'pigeons/bota_api.dart',
  'pubspec.yaml',
  'test/bridge_contract_test.dart',
  'test/package_contract_test.dart',
];
const EXPECTED_DART_CONSTRAINT = '>=3.11.0 <4.0.0';
const EXPECTED_FLUTTER_CONSTRAINT = '>=3.41.0';

const readSdkVersion = (path) => {
  const source = readFileSync(path, 'utf8');
  const match = source.match(/^version\s*=\s*"([^"]+)"\s*$/m);
  if (!match) throw new Error(`cannot read SDK version from ${path}`);
  return match[1];
};

const parseScalar = (source, lineNumber) => {
  if (source.startsWith('"')) {
    try {
      return JSON.parse(source);
    } catch {
      throw new Error(`invalid quoted YAML scalar on line ${lineNumber}`);
    }
  }
  if (source.startsWith("'")) {
    if (!source.endsWith("'")) {
      throw new Error(`invalid quoted YAML scalar on line ${lineNumber}`);
    }
    return source.slice(1, -1).replaceAll("''", "'");
  }
  if (/[[\]{}]/.test(source)) {
    throw new Error(`inline YAML collections are not supported on line ${lineNumber}`);
  }
  return source;
};

const parsePubspec = (source) => {
  if (/(^|[\s:[{,])(?:&|\*)(?=\S)/m.test(source)) {
    throw new Error('YAML anchors or aliases are not allowed in pubspec.yaml');
  }

  const root = {};
  const stack = [{ indent: -2, value: root }];
  for (const [index, rawLine] of source.replaceAll('\r\n', '\n').split('\n').entries()) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    if (rawLine.includes('\t')) {
      throw new Error(`tabs are not allowed in pubspec.yaml on line ${index + 1}`);
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent % 2 !== 0) {
      throw new Error(`invalid YAML indentation on line ${index + 1}`);
    }
    const match = rawLine.trim().match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/);
    if (!match) throw new Error(`unsupported YAML on line ${index + 1}`);

    while (stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1);
    if (!parent || indent !== parent.indent + 2) {
      throw new Error(`invalid YAML nesting on line ${index + 1}`);
    }

    const [, key, scalar] = match;
    if (Object.hasOwn(parent.value, key)) {
      throw new Error(`duplicate YAML key ${key} on line ${index + 1}`);
    }
    if (scalar === undefined) {
      const value = {};
      parent.value[key] = value;
      stack.push({ indent, value });
    } else {
      parent.value[key] = parseScalar(scalar, index + 1);
    }
  }
  return root;
};

const assertInsidePackage = (packageRoot, path) => {
  const destination = realpathSync(path);
  const fromPackage = relative(realpathSync(packageRoot), destination);
  if (fromPackage === '..' || fromPackage.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromPackage)) {
    throw new Error(`Flutter package symlink escapes package root: ${path}`);
  }
};

const verifySymlinks = (packageRoot, directory = packageRoot) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      assertInsidePackage(packageRoot, path);
    } else if (entry.isDirectory()) {
      verifySymlinks(packageRoot, path);
    }
  }
};

const expectEqual = (actual, expected, message) => {
  if (actual !== expected) throw new Error(message(actual));
};

export const verifyFlutterPackage = (root) => {
  const workspaceRoot = resolve(root);
  const packageRoot = resolve(workspaceRoot, PACKAGE_PATH);
  if (!existsSync(packageRoot) || !lstatSync(packageRoot).isDirectory()) {
    throw new Error(`Flutter package is missing: ${packageRoot}`);
  }

  for (const file of REQUIRED_FILES) {
    if (!existsSync(resolve(packageRoot, file))) {
      throw new Error(`Flutter package is missing ${file}`);
    }
  }
  verifySymlinks(packageRoot);

  const sdkVersion = readSdkVersion(resolve(workspaceRoot, 'sdk-version.toml'));
  const pubspec = parsePubspec(readFileSync(resolve(packageRoot, 'pubspec.yaml'), 'utf8'));

  expectEqual(pubspec.name, 'bota_flutter_sdk', (actual) =>
    `Flutter package name ${actual ?? '(missing)'} does not match bota_flutter_sdk`
  );
  expectEqual(pubspec.version, sdkVersion, (actual) =>
    `Flutter package version ${actual ?? '(missing)'} does not match ${sdkVersion}`
  );
  expectEqual(pubspec.environment?.sdk, EXPECTED_DART_CONSTRAINT, () =>
    `Dart SDK constraint must be ${EXPECTED_DART_CONSTRAINT}`
  );
  expectEqual(pubspec.environment?.flutter, EXPECTED_FLUTTER_CONSTRAINT, () =>
    `Flutter SDK constraint must be ${EXPECTED_FLUTTER_CONSTRAINT}`
  );
  expectEqual(pubspec.dependencies?.flutter?.sdk, 'flutter', () =>
    'Flutter SDK dependency is required'
  );
  expectEqual(pubspec.dependencies?.meta, '1.19.0', () =>
    'meta version must be exactly 1.19.0'
  );
  expectEqual(pubspec.dev_dependencies?.flutter_test?.sdk, 'flutter', () =>
    'Flutter test SDK dependency is required'
  );
  expectEqual(pubspec.dev_dependencies?.flutter_lints, '6.0.0', () =>
    'flutter_lints version must be exactly 6.0.0'
  );
  expectEqual(pubspec.dev_dependencies?.pigeon, '28.0.0', () =>
    'Pigeon version must be exactly 28.0.0'
  );
  const platforms = pubspec.flutter?.plugin?.platforms;
  if (!platforms || Object.keys(platforms).sort().join(',') !== 'android,ios') {
    throw new Error('Flutter plugin platforms must contain exactly android and ios');
  }
  expectEqual(platforms.android?.package, 'dev.bota.sdk.flutter', () =>
    'Flutter Android package must be dev.bota.sdk.flutter'
  );
  expectEqual(platforms.android?.pluginClass, 'BotaFlutterSdkPlugin', () =>
    'Flutter Android plugin class must be BotaFlutterSdkPlugin'
  );
  expectEqual(platforms.ios?.pluginClass, 'BotaFlutterSdkPlugin', () =>
    'Flutter iOS plugin class must be BotaFlutterSdkPlugin'
  );

  return { packageName: pubspec.name, sdkVersion };
};

const modulePath = fileURLToPath(import.meta.url);
if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === realpathSync(modulePath)
) {
  try {
    const result = verifyFlutterPackage(
      resolve(fileURLToPath(new URL('../..', import.meta.url)))
    );
    console.log(
      `Flutter package metadata verified: ${result.packageName}@${result.sdkVersion}`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
