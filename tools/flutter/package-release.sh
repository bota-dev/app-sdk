#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGE_PATH="frameworks/flutter/bota_flutter_sdk"
PACKAGE_ROOT="$ROOT/$PACKAGE_PATH"
OUTPUT="$ROOT/target/flutter-release"
MODE="${1:-}"
OCCUPIED_VERSION="1.2.0-beta.0"

if [[ "$MODE" != "--check" && "$MODE" != "--write-example" ]] || [[ $# -ne 1 ]]; then
  echo "usage: $0 <--check|--write-example>" >&2
  exit 2
fi

sdk_version="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$ROOT/sdk-version.toml")"
source_revision="$(git -C "$ROOT" rev-parse HEAD)"
if [[ "$sdk_version" == "$OCCUPIED_VERSION" ]]; then
  echo "Flutter release version $sdk_version is occupied by an immutable tag and must not be reused" >&2
  exit 1
fi
if [[ -z "$sdk_version" ]] || [[ ! "$source_revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Flutter release metadata is not synchronized" >&2
  exit 1
fi
EXAMPLE_MANIFEST="$ROOT/release/examples/$sdk_version.json"
if [[ ! -f "$EXAMPLE_MANIFEST" ]]; then
  echo "Flutter release example is missing for synchronized version $sdk_version" >&2
  exit 1
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$node_major" -lt 22 ]]; then
  echo "Flutter release packaging requires Node.js 22 or newer" >&2
  exit 1
fi

mkdir -p "$ROOT/target"
temporary="$(mktemp -d "$ROOT/target/flutter-release.XXXXXX")"
cleanup() { rm -rf "$temporary"; }
trap cleanup EXIT

run_and_record() {
  local output="$1"
  shift
  "$@" 2>&1 | tee "$temporary/$output"
}

node "$ROOT/tools/flutter/verify-package.mjs"
run_and_record pub-get.txt \
  "$ROOT/tools/flutter/run-flutter.sh" pub get --directory="$PACKAGE_ROOT"
cp "$PACKAGE_ROOT/pubspec.lock" "$temporary/pubspec.lock"

run_and_record pigeon-check.txt node "$ROOT/tools/flutter/verify-pigeon.mjs"
dart_files=()
while IFS= read -r path; do
  [[ "$path" == "$PACKAGE_ROOT/lib/src/generated/"* ]] || dart_files+=("$path")
done < <(find \
  "$PACKAGE_ROOT/lib" "$PACKAGE_ROOT/pigeons" "$PACKAGE_ROOT/test" \
  "$PACKAGE_ROOT/example/lib" -type f -name '*.dart' | LC_ALL=C sort)
run_and_record format-check.txt \
  "$ROOT/tools/flutter/run-dart.sh" format --output=none --set-exit-if-changed \
  "${dart_files[@]}"
run_and_record analyze.txt \
  "$ROOT/tools/flutter/run-flutter.sh" analyze "$PACKAGE_ROOT"
run_and_record test.txt \
  "$ROOT/tools/flutter/run-flutter.sh" test "$PACKAGE_ROOT/test"

"$ROOT/tools/flutter/run-dart.sh" pub deps --json \
  --directory="$PACKAGE_ROOT" >"$temporary/dependencies.json"
node --input-type=module - \
  "$PACKAGE_ROOT/.dart_tool/package_config.json" \
  "$temporary/dependencies.json" \
  "$temporary/dependency-licenses.json" <<'NODE'
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , configPath, dependenciesPath, outputPath] = process.argv;
const config = JSON.parse(await readFile(configPath, 'utf8'));
const dependencies = JSON.parse(await readFile(dependenciesPath, 'utf8'));
const configByName = new Map(config.packages.map((entry) => [entry.name, entry]));
const denied = /GNU (?:AFFERO )?GENERAL PUBLIC LICENSE|SERVER SIDE PUBLIC LICENSE|BUSINESS SOURCE LICENSE/i;
const packages = [];
for (const dependency of dependencies.packages
  .filter((entry) => entry.source === 'hosted')
  .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
  const packageConfig = configByName.get(dependency.name);
  if (!packageConfig) throw new Error(`missing package config for ${dependency.name}`);
  const root = fileURLToPath(new URL(packageConfig.rootUri, new URL(`file://${resolve(dirname(configPath))}/`)));
  const names = (await readdir(root))
    .filter((name) => /^(?:LICENSE|COPYING)(?:\.|$)/i.test(name))
    .sort();
  if (names.length === 0) throw new Error(`${dependency.name}@${dependency.version} has no license file`);
  const licenseFiles = [];
  for (const name of names) {
    const contents = await readFile(resolve(root, name));
    if (denied.test(contents.toString('utf8'))) {
      throw new Error(`${dependency.name}@${dependency.version} has a denied license`);
    }
    licenseFiles.push({
      name,
      sha256: createHash('sha256').update(contents).digest('hex'),
    });
  }
  packages.push({ name: dependency.name, version: dependency.version, licenseFiles });
}
await writeFile(outputPath, `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`);
console.log(`Flutter dependency license check passed for ${packages.length} hosted packages`);
NODE

(
  cd "$PACKAGE_ROOT"
  "$ROOT/tools/flutter/run-flutter.sh" pub publish --dry-run
) 2>&1 | tee "$temporary/publish-dry-run-raw.txt"
run_and_record example-builds.txt "$ROOT/tools/flutter/test-consumers.sh"
sed -n '/^Publishing /,$p' "$temporary/publish-dry-run-raw.txt" \
  >"$temporary/publish-dry-run.txt"
node --input-type=module - "$sdk_version" "$source_revision" \
  "$temporary/verification.json" <<'NODE'
import { writeFile } from 'node:fs/promises';

const [, , version, sourceRevision, output] = process.argv;
const evidence = {
  schemaVersion: 1,
  packageName: 'bota_flutter_sdk',
  version,
  sourceRevision,
  generator: { name: 'pigeon', version: '28.0.0' },
  checks: [
    'package-metadata',
    'pub-get-lock',
    'pigeon-drift',
    'dart-format',
    'flutter-analyze',
    'flutter-test',
    'dependency-licenses',
    'publish-dry-run',
    'android-release-example',
    'ios-release-example',
  ].map((name) => ({ name, status: 'passed' })),
};
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
NODE

git -C "$ROOT" ls-files --cached -- "$PACKAGE_PATH" \
  | sed "s#^$PACKAGE_PATH/##" \
  | awk -F/ '!/^\./ { hidden = 0; for (i = 1; i <= NF; i++) if ($i ~ /^\./) hidden = 1; if (!hidden) print }' \
  | LC_ALL=C sort -u >"$temporary/package-files.txt"
if [[ ! -s "$temporary/package-files.txt" ]]; then
  echo "Flutter package inventory is empty" >&2
  exit 1
fi

archive="$temporary/bota_flutter_sdk-$sdk_version.tar.gz"
inventory="$temporary/package-inventory.json"
node "$ROOT/tools/flutter/verify-publication.mjs" create-candidate \
  --package-root "$PACKAGE_ROOT" \
  --archive "$archive" \
  --inventory "$inventory" \
  --source-revision "$source_revision" \
  --files "$temporary/package-files.txt"
node "$ROOT/tools/flutter/verify-publication.mjs" verify-candidate \
  --archive "$archive" \
  --inventory "$inventory"
node "$ROOT/tools/flutter/verify-publication.mjs" write-release-manifest \
  --template "$EXAMPLE_MANIFEST" \
  --inventory "$inventory" \
  --apple-package "$ROOT/Package.swift" \
  --output "$temporary/release-manifest.json"

if [[ "$MODE" == "--write-example" ]]; then
  cp "$temporary/release-manifest.json" "$EXAMPLE_MANIFEST"
else
  node "$ROOT/tools/flutter/verify-publication.mjs" \
    verify-release-manifest-template \
    --manifest "$temporary/release-manifest.json" \
    --template "$EXAMPLE_MANIFEST"
fi

rm -rf "$OUTPUT"
mkdir -p "$OUTPUT"
for file in \
  "$(basename "$archive")" \
  dependencies.json \
  dependency-licenses.json \
  package-files.txt \
  package-inventory.json \
  publish-dry-run.txt \
  pubspec.lock \
  release-manifest.json \
  verification.json
do
  cp "$temporary/$file" "$OUTPUT/$file"
done
printf 'Flutter candidate %s (%s) is preserved at %s\n' \
  "$sdk_version" "$(shasum -a 256 "$OUTPUT/$(basename "$archive")" | awk '{print $1}')" "$OUTPUT"
