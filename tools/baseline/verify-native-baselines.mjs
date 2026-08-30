import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function git(directory, ...args) {
  try {
    return execFileSync('git', args, {
      cwd: resolve(directory),
      encoding: 'utf8',
    }).trimEnd();
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`cannot inspect native baseline at ${directory}: ${detail}`);
  }
}

function statusPath(line) {
  const value = line.slice(3);
  const renameSeparator = value.lastIndexOf(' -> ');
  return renameSeparator === -1 ? value : value.slice(renameSeparator + 4);
}

function verifyPlatform(label, expected, directory, allowDirtyPaths) {
  if (!expected?.revision || !/^[0-9a-f]{40}$/.test(expected.revision)) {
    throw new Error(`${label} baseline has an invalid revision`);
  }

  const revision = git(directory, 'rev-parse', 'HEAD');
  if (revision !== expected.revision) {
    throw new Error(
      `${label} revision ${revision} does not match ${expected.revision}`,
    );
  }

  const status = git(directory, 'status', '--porcelain=v1', '--untracked-files=all');
  const lines = status ? status.split('\n') : [];
  const dirtyPaths = lines.map(statusPath);
  const unexpected = lines.filter(
    (line, index) => !allowDirtyPaths.has(dirtyPaths[index]),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `${label} baseline is dirty: ${unexpected.map((line) => line.trimStart()).join(', ')}`,
    );
  }

  return { revision, dirtyPaths };
}

export function verifyNativeBaselines({
  manifest,
  applePath,
  androidPath,
  allowDirtyPaths = [],
}) {
  if (manifest?.schemaVersion !== 1) {
    throw new Error('native baseline manifest schemaVersion must be 1');
  }
  if (!applePath || !androidPath) {
    throw new Error('both Apple and Android baseline paths are required');
  }

  const allowed = new Set(allowDirtyPaths);
  return {
    apple: verifyPlatform(
      'Apple',
      manifest.platforms?.apple,
      applePath,
      allowed,
    ),
    android: verifyPlatform(
      'Android',
      manifest.platforms?.android,
      androidPath,
      allowed,
    ),
  };
}

function parseArguments(args) {
  const options = {
    manifestPath: 'protocol/baseline/native-sdks.json',
    applePath: null,
    androidPath: null,
    allowDirtyPaths: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case '--manifest':
        options.manifestPath = args[++index];
        break;
      case '--apple-path':
        options.applePath = args[++index];
        break;
      case '--android-path':
        options.androidPath = args[++index];
        break;
      case '--allow-dirty-docs': {
        const path = args[++index];
        if (!path?.endsWith('.md')) {
          throw new Error('--allow-dirty-docs accepts one Markdown path');
        }
        options.allowDirtyPaths.push(path);
        break;
      }
      default:
        throw new Error(`unknown argument ${args[index]}`);
    }
  }
  return options;
}

const isMain = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const manifest = JSON.parse(
      readFileSync(resolve(options.manifestPath), 'utf8'),
    );
    const result = verifyNativeBaselines({ ...options, manifest });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
