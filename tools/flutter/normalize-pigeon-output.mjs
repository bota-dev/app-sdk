#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const normalizePigeonOutput = (source) => source.replace(/[ \t]+$/gm, '');

export const normalizePigeonFile = async (path) => {
  const source = await readFile(path, 'utf8');
  const normalized = normalizePigeonOutput(source);
  if (normalized !== source) await writeFile(path, normalized);
};

const modulePath = fileURLToPath(import.meta.url);
if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === realpathSync(modulePath)
) {
  await Promise.all(process.argv.slice(2).map(normalizePigeonFile));
}
