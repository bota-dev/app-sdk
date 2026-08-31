#!/usr/bin/env node

import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = await import('../package.json', { with: { type: 'json' } });

const run = (script, args) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `Codegen command failed: ${result.stderr || result.stdout || script}`
    );
  }
};

export const generateCodegen = (outputPath) => {
  const output = resolve(outputPath);
  const schemaPath = resolve(output, 'schema.json');
  const codegenName = packageJson.default.codegenConfig.name;
  const javaPackage =
    packageJson.default.codegenConfig.android.javaPackageName;

  rmSync(output, { force: true, recursive: true });
  mkdirSync(output, { recursive: true });

  run(
    resolve(
      packageRoot,
      'node_modules/@react-native/codegen/lib/cli/combine/combine-js-to-schema-cli.js'
    ),
    [
      '--libraryName',
      codegenName,
      schemaPath,
      resolve(packageRoot, 'src/specs/NativeBotaDeviceSDK.ts'),
    ]
  );

  for (const platform of ['ios', 'android']) {
    const args = [
      '--platform',
      platform,
      '--schemaPath',
      schemaPath,
      '--outputDir',
      resolve(output, platform),
      '--libraryName',
      codegenName,
      '--libraryType',
      'modules',
    ];
    if (platform === 'android') {
      args.push('--javaPackageName', javaPackage);
    }
    run(
      resolve(packageRoot, 'node_modules/react-native/scripts/generate-specs-cli.js'),
      args
    );
  }

  return output;
};

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const outputIndex = process.argv.indexOf('--output');
  const output =
    outputIndex >= 0 && process.argv[outputIndex + 1]
      ? process.argv[outputIndex + 1]
      : resolve(packageRoot, 'generated/build');

  try {
    console.log(`Generated React Native artifacts at ${generateCodegen(output)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
