#!/usr/bin/env bash
set -euo pipefail

SOURCE_REVISION=""
OUTPUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-revision)
      SOURCE_REVISION="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -* )
      echo "unknown option: $1" >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

if [[ ! "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ || -z "$OUTPUT" || $# -lt 1 ]]; then
  echo "usage: $0 --source-revision <40-hex> --output <json> <release-directory>..." >&2
  exit 2
fi

node --input-type=module - "$SOURCE_REVISION" "$OUTPUT" "$@" <<'NODE'
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const [, , sourceRevision, output, ...roots] = process.argv;
const files = [];
const rootNames = new Set();
for (const value of roots) {
  const root = resolve(value);
  const rootName = basename(root);
  if (rootNames.has(rootName)) throw new Error(`duplicate release directory name ${rootName}`);
  rootNames.add(rootName);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error(`${root} is not a directory`);
  await visit(root, root, rootName);
}

files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
const inventory = { schemaVersion: 1, sourceRevision, files };
const target = resolve(output);
const temporary = `${target}.tmp-${process.pid}`;
await mkdir(dirname(target), { recursive: true });
await writeFile(temporary, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o644 });
await rename(temporary, target);

async function visit(root, directory, rootName) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(root, path, rootName);
    } else if (entry.isFile()) {
      const contents = await readFile(path);
      files.push({
        path: `${rootName}/${relative(root, path).split(sep).join('/')}`,
        byteLength: contents.length,
        sha256: createHash('sha256').update(contents).digest('hex'),
      });
    } else {
      throw new Error(`unsupported release entry ${path}`);
    }
  }
}
NODE
