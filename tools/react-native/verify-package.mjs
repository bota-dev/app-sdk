#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_PACKAGE = '@bota.dev/react-native-sdk';
const EXPECTED_REACT_NATIVE_FLOOR = '0.86.3';
const EXPECTED_NATIVE_MODULE = 'BotaDeviceSDK';
const EXPECTED_CODEGEN_LIBRARY = 'BotaDeviceSDKSpec';
const EXPECTED_APPLE_DEPLOYMENT_TARGET = '15.1';
const EXPECTED_APPLE_PACKAGE_URL = 'https://github.com/bota-dev/app-sdk.git';
const EXPECTED_APPLE_PRODUCT = 'BotaAppleSDK';
const EXPECTED_COCOAPODS_VERSION = '1.13.0';
const EXPECTED_LOCAL_APPLE_PATH_ENV = 'BOTA_APPLE_SDK_PACKAGE_PATH';
const EXPECTED_SWIFT_VERSION = '6.0';
const EXPECTED_APPLE_SPM_WORKAROUND = 'scripts/bota_device_sdk_spm_workaround.rb';
const EXPECTED_ANDROID_COMPILE_SDK = 36;
const EXPECTED_ANDROID_COROUTINES_VERSION = '1.11.0';
const EXPECTED_ANDROID_KOTLIN_VERSION = '2.3.20';
const EXPECTED_ANDROID_MAVEN_COORDINATE = 'dev.bota:bota-android-sdk';
const EXPECTED_ANDROID_MIN_SDK = 26;
const EXPECTED_ANDROID_NAMESPACE = 'dev.bota.sdk.reactnative';

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
  if (!packageJson.files?.includes('BotaDeviceSDK.podspec')) {
    throw new Error('React Native npm files must include BotaDeviceSDK.podspec');
  }
  if (!packageJson.files?.includes(EXPECTED_APPLE_SPM_WORKAROUND)) {
    throw new Error('React Native npm files must include the Apple SPM workaround');
  }
  if (!packageJson.files?.includes('android/')) {
    throw new Error('React Native npm files must include android/');
  }

  for (const path of [
    'android/build.gradle',
    'android/src/main/AndroidManifest.xml',
  ]) {
    if (!existsSync(resolve(packageRoot, path))) {
      throw new Error(`React Native Android package is missing ${path}`);
    }
  }

  const android = packageJson.bota?.android;
  if (android?.namespace !== EXPECTED_ANDROID_NAMESPACE) {
    throw new Error(`Android namespace must be ${EXPECTED_ANDROID_NAMESPACE}`);
  }
  if (android?.minSdkVersion !== EXPECTED_ANDROID_MIN_SDK) {
    throw new Error(`Android minimum SDK must be ${EXPECTED_ANDROID_MIN_SDK}`);
  }
  if (android?.compileSdkVersion !== EXPECTED_ANDROID_COMPILE_SDK) {
    throw new Error(`Android compile SDK must be ${EXPECTED_ANDROID_COMPILE_SDK}`);
  }
  if (android?.kotlinVersion !== EXPECTED_ANDROID_KOTLIN_VERSION) {
    throw new Error(`Android Kotlin version must be ${EXPECTED_ANDROID_KOTLIN_VERSION}`);
  }
  if (android?.coroutinesVersion !== EXPECTED_ANDROID_COROUTINES_VERSION) {
    throw new Error(
      `Android coroutines version must be ${EXPECTED_ANDROID_COROUTINES_VERSION}`
    );
  }
  if (android?.mavenCoordinate !== EXPECTED_ANDROID_MAVEN_COORDINATE) {
    throw new Error(
      `Android Maven coordinate must be ${EXPECTED_ANDROID_MAVEN_COORDINATE}`
    );
  }

  const apple = packageJson.bota?.apple;
  if (apple?.podName !== EXPECTED_NATIVE_MODULE) {
    throw new Error(`Apple pod name must be ${EXPECTED_NATIVE_MODULE}`);
  }
  if (apple?.moduleName !== EXPECTED_NATIVE_MODULE) {
    throw new Error(`Apple module name must be ${EXPECTED_NATIVE_MODULE}`);
  }
  if (apple?.deploymentTarget !== EXPECTED_APPLE_DEPLOYMENT_TARGET) {
    throw new Error(
      `Apple deployment target must be ${EXPECTED_APPLE_DEPLOYMENT_TARGET}`
    );
  }
  if (apple?.swiftVersion !== EXPECTED_SWIFT_VERSION) {
    throw new Error(`Apple Swift version must be ${EXPECTED_SWIFT_VERSION}`);
  }
  if (apple?.cocoapodsVersion !== EXPECTED_COCOAPODS_VERSION) {
    throw new Error(
      `Apple CocoaPods version must be ${EXPECTED_COCOAPODS_VERSION} or newer`
    );
  }
  if (apple?.packageUrl !== EXPECTED_APPLE_PACKAGE_URL) {
    throw new Error(`Apple package URL must be ${EXPECTED_APPLE_PACKAGE_URL}`);
  }
  if (apple?.packageRequirement !== 'exactVersion') {
    throw new Error('Apple package requirement must be exactVersion');
  }
  if (apple?.packageProduct !== EXPECTED_APPLE_PRODUCT) {
    throw new Error(`Apple package product must be ${EXPECTED_APPLE_PRODUCT}`);
  }
  if (apple?.localPackagePathEnvironment !== EXPECTED_LOCAL_APPLE_PATH_ENV) {
    throw new Error(
      `local Apple package path environment must be ${EXPECTED_LOCAL_APPLE_PATH_ENV}`
    );
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
