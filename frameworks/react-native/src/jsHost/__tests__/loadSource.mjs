import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = new Map();

/** Run the exact TS source with the installed compiler; no artifacts or downloads. */
export function loadSource(name) {
  const path = resolve(directory, name);
  if (cache.has(path)) return cache.get(path).exports;
  const module = { exports: {} };
  cache.set(path, module);
  const output = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const localRequire = identifier => identifier.startsWith('.')
    ? loadSource(resolve(dirname(path), `${identifier}.ts`))
    : require(identifier);
  new Function('require', 'exports', 'module', output)(localRequire, module.exports, module);
  return module.exports;
}
