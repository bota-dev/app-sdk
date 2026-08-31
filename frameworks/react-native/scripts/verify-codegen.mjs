#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateCodegen } from './generate-codegen.mjs';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(
  readFileSync(resolve(packageRoot, 'package.json'), 'utf8')
);
const contractPath = resolve(
  packageRoot,
  'generated/codegen-contract.json'
);

const sha256 = (value) =>
  createHash('sha256').update(value).digest('hex');

const canonicalJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

const listFiles = (root, current = root) =>
  readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(current, entry.name);
      return entry.isDirectory() ? listFiles(root, path) : [path];
    });

const artifactsFor = (root, platform) => {
  const platformRoot = resolve(root, platform);
  return listFiles(platformRoot).map((path) => {
    if (!statSync(path).isFile()) throw new Error(`not a file: ${path}`);
    const content = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
    return {
      path: relative(platformRoot, path).replaceAll('\\', '/'),
      sha256: sha256(content),
    };
  });
};

const buildContract = (generatedRoot) => {
  const schema = JSON.parse(
    readFileSync(resolve(generatedRoot, 'schema.json'), 'utf8')
  );
  const moduleName = Object.values(schema.modules)[0]?.moduleName;
  if (moduleName !== packageJson.bota.nativeModuleName) {
    throw new Error(
      `generated native module ${moduleName ?? '(missing)'} does not match ${packageJson.bota.nativeModuleName}`
    );
  }

  const contract = {
    schemaVersion: 1,
    package: packageJson.name,
    packageVersion: packageJson.version,
    reactNativeVersion: packageJson.devDependencies['react-native'],
    codegenLibrary: packageJson.codegenConfig.name,
    nativeModule: moduleName,
    schema,
    artifacts: {
      android: artifactsFor(generatedRoot, 'android'),
      ios: artifactsFor(generatedRoot, 'ios'),
    },
  };

  return {
    ...contract,
    contractDigest: sha256(JSON.stringify(contract)),
  };
};

const temporaryRoot = mkdtempSync(join(tmpdir(), 'bota-rn-codegen-'));

try {
  generateCodegen(temporaryRoot);
  const generated = canonicalJson(buildContract(temporaryRoot));

  if (process.argv.includes('--write')) {
    mkdirSync(resolve(packageRoot, 'generated'), { recursive: true });
    writeFileSync(contractPath, generated);
    console.log(`Codegen contract written: ${contractPath}`);
  } else {
    const committed = readFileSync(contractPath, 'utf8');
    if (committed !== generated) {
      throw new Error(
        'Codegen contract drifted; run npm run codegen and review the generated contract'
      );
    }
    const contract = JSON.parse(generated);
    console.log(
      `Codegen contract verified: ${contract.nativeModule} ${contract.contractDigest}`
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
