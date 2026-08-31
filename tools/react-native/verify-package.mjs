#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_PACKAGE = '@bota.dev/react-native-sdk';
const EXPECTED_REACT_NATIVE_FLOOR = '0.86.3';
const EXPECTED_NATIVE_MODULE = 'BotaDeviceSDK';
const EXPECTED_CODEGEN_LIBRARY = 'BotaDeviceSDKSpec';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const readSdkVersion = (path) => {
  const source = readFileSync(path, 'utf8');
  const match = source.match(/^version\s*=\s*"([^"]+)"\s*$/m);
  if (!match) {
    throw new Error(`cannot read SDK version from ${path}`);
  }
  return match[1];
};

const readArgument = (args, name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a path`);
  return args[index + 1];
};

export const verifyPackage = ({ workspaceRoot, packageRoot }) => {
  const sdkVersion = readSdkVersion(resolve(workspaceRoot, 'sdk-version.toml'));
  const workspacePackage = readJson(resolve(workspaceRoot, 'package.json'));
  const packageJson = readJson(resolve(packageRoot, 'package.json'));

  if (packageJson.name !== EXPECTED_PACKAGE) {
    throw new Error(
      `React Native package name ${packageJson.name ?? '(missing)'} does not match ${EXPECTED_PACKAGE}`
    );
  }
  if (packageJson.private !== true) {
    throw new Error('React Native package must remain private until migration gates pass');
  }
  if (workspacePackage.private !== true) {
    throw new Error('workspace package must remain private');
  }
  if (workspacePackage.version !== sdkVersion) {
    throw new Error(
      `workspace version ${workspacePackage.version} does not match ${sdkVersion}`
    );
  }
  if (packageJson.version !== sdkVersion) {
    throw new Error(
      `React Native package version ${packageJson.version} does not match ${sdkVersion}`
    );
  }
  if (packageJson.bota?.reactNativeFloor !== EXPECTED_REACT_NATIVE_FLOOR) {
    throw new Error(
      `React Native floor ${packageJson.bota?.reactNativeFloor ?? '(missing)'} does not match ${EXPECTED_REACT_NATIVE_FLOOR}`
    );
  }
  if (packageJson.devDependencies?.['react-native'] !== EXPECTED_REACT_NATIVE_FLOOR) {
    throw new Error(
      `React Native development version must be exactly ${EXPECTED_REACT_NATIVE_FLOOR}`
    );
  }
  if (
    packageJson.peerDependencies?.['react-native'] !==
    `>=${EXPECTED_REACT_NATIVE_FLOOR} <1.0`
  ) {
    throw new Error(
      `React Native peer range must be >=${EXPECTED_REACT_NATIVE_FLOOR} <1.0`
    );
  }
  if (packageJson.bota?.nativeModuleName !== EXPECTED_NATIVE_MODULE) {
    throw new Error(
      `React Native native module name ${packageJson.bota?.nativeModuleName ?? '(missing)'} does not match ${EXPECTED_NATIVE_MODULE}`
    );
  }
  if (packageJson.codegenConfig?.name !== EXPECTED_CODEGEN_LIBRARY) {
    throw new Error(
      `React Native Codegen library must be ${EXPECTED_CODEGEN_LIBRARY}`
    );
  }
  if (packageJson.codegenConfig?.type !== 'modules') {
    throw new Error('React Native Codegen type must be modules');
  }
  if (packageJson.codegenConfig?.jsSrcsDir !== './src/specs') {
    throw new Error('React Native Codegen source directory must be ./src/specs');
  }

  return { packageName: packageJson.name, sdkVersion };
};

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const workspaceRoot = resolve(
    readArgument(args, '--workspace-root', process.cwd())
  );
  const packageRoot = resolve(
    readArgument(
      args,
      '--package-root',
      resolve(workspaceRoot, 'frameworks/react-native')
    )
  );

  try {
    const result = verifyPackage({ workspaceRoot, packageRoot });
    console.log(
      `React Native package metadata verified: ${result.packageName}@${result.sdkVersion}`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
