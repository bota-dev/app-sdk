#!/usr/bin/env node

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const generatedPigeonFiles = Object.freeze([
  'frameworks/flutter/bota_flutter_sdk/lib/src/generated/bota_api.g.dart',
  'frameworks/flutter/bota_flutter_sdk/ios/bota_flutter_sdk/Sources/bota_flutter_sdk/BotaApi.g.swift',
  'frameworks/flutter/bota_flutter_sdk/android/src/main/kotlin/dev/bota/sdk/flutter/BotaApi.g.kt',
]);

const runGenerator = (root, outputRoot) => new Promise((resolveRun, reject) => {
  const child = spawn(resolve(root, 'tools/flutter/generate-pigeon.sh'), [], {
    cwd: root,
    env: { ...process.env, BOTA_PIGEON_OUTPUT_ROOT: outputRoot },
    stdio: 'inherit',
  });
  child.on('error', reject);
  child.on('exit', (code, signal) => {
    if (code === 0) {
      resolveRun();
      return;
    }
    reject(new Error(
      `Pigeon generation failed${signal ? ` with signal ${signal}` : ` with exit ${code}`}`,
    ));
  });
});

export const verifyPigeon = async (root, { generate } = {}) => {
  const workspaceRoot = resolve(root);
  const outputRoot = mkdtempSync(join(tmpdir(), 'bota-pigeon-verify-'));
  try {
    await (generate ?? ((target) => runGenerator(workspaceRoot, target)))(outputRoot);
    const drift = [];
    for (const file of generatedPigeonFiles) {
      const committed = readFileSync(resolve(workspaceRoot, file));
      const generated = readFileSync(resolve(outputRoot, file));
      if (!committed.equals(generated)) drift.push(file);
    }
    if (drift.length > 0) {
      throw new Error(`generated Pigeon output drift: ${drift.join(', ')}`);
    }
    return generatedPigeonFiles;
  } finally {
    rmSync(outputRoot, { force: true, recursive: true });
  }
};

const modulePath = fileURLToPath(import.meta.url);
if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === realpathSync(modulePath)
) {
  try {
    const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
    await verifyPigeon(root);
    console.log(
      `Pigeon outputs verified: ${generatedPigeonFiles.map((file) => relative(root, resolve(root, file))).join(', ')}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
