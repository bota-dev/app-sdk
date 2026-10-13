#!/usr/bin/env bash
set -euo pipefail

# The React Native Hermes 0.17 release, pinned to its exact upstream source.
hermes_source_commit=829dcd74f5b774d19a86ab1dc47e3dee9e44d190
hermes_source_tag=hermes-v0.17.0
hermes_source_repository=https://github.com/facebook/hermes.git
hermes_repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
hermes_jobs=${HERMES_BUILD_JOBS:-2}

[[ $(uname -s) == Linux ]] || { echo 'The pinned Hermes runtime helper requires Linux.' >&2; exit 1; }
[[ $hermes_jobs =~ ^[1-9][0-9]*$ ]] || { echo 'HERMES_BUILD_JOBS must be a positive integer.' >&2; exit 1; }
for hermes_dependency in git cmake ninja node c++ python3 zip; do
  command -v "$hermes_dependency" >/dev/null || { echo "Missing build dependency: $hermes_dependency" >&2; exit 1; }
done

# All checkouts and build files stay inside this repository's physical target.
# Reuse a clean exact-source checkout; never delete or force-reset a checkout.
mkdir -p "$hermes_repo_root/target"
hermes_target=$(cd "$hermes_repo_root/target" && pwd -P)
[[ $hermes_target == "$hermes_repo_root/target" ]] || { echo 'target must not point outside the repository.' >&2; exit 1; }
hermes_work="$hermes_target/hermes-runtime/${hermes_source_commit:0:12}"
mkdir -p "$hermes_work/source" "$hermes_work/build"
hermes_work=$(cd "$hermes_work" && pwd -P)
[[ $hermes_work == "$hermes_target/hermes-runtime/${hermes_source_commit:0:12}" ]] || { echo 'Hermes work directory escaped target.' >&2; exit 1; }
hermes_source_dir=$(cd "$hermes_work/source" && pwd -P)
hermes_build_dir=$(cd "$hermes_work/build" && pwd -P)
[[ $hermes_source_dir == "$hermes_work/source" && $hermes_build_dir == "$hermes_work/build" ]] || { echo 'Hermes source/build directory escaped target.' >&2; exit 1; }

if [[ ! -d $hermes_source_dir/.git ]]; then
  [[ -z $(ls -A "$hermes_source_dir") ]] || { echo 'Refusing to initialize a nonempty Hermes source directory.' >&2; exit 1; }
  git init --quiet "$hermes_source_dir"
  git -C "$hermes_source_dir" remote add origin "$hermes_source_repository"
fi
[[ $(git -C "$hermes_source_dir" rev-parse --show-toplevel) == "$hermes_source_dir" ]] || { echo 'Hermes source is not its own checkout.' >&2; exit 1; }
[[ $(git -C "$hermes_source_dir" remote get-url origin) == "$hermes_source_repository" ]] || { echo 'Unexpected Hermes source remote.' >&2; exit 1; }
[[ -z $(git -C "$hermes_source_dir" status --porcelain) ]] || { echo 'Refusing to replace modified Hermes source.' >&2; exit 1; }
git -C "$hermes_source_dir" fetch --depth 1 --no-tags origin "$hermes_source_commit"
git -C "$hermes_source_dir" checkout --quiet --detach "$hermes_source_commit"
[[ $(git -C "$hermes_source_dir" rev-parse HEAD) == "$hermes_source_commit" ]] || { echo 'Hermes source commit mismatch.' >&2; exit 1; }

cmake -S "$hermes_source_dir" -B "$hermes_build_dir" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DHERMES_RELEASE_VERSION=0.17.0 \
  -DHERMES_ENABLE_TOOLS=ON \
  -DHERMES_ENABLE_DEBUGGER=OFF \
  -DHERMES_MEMORY_INSTRUMENTATION=OFF \
  -DHERMES_ENABLE_INTL=OFF \
  -DHERMES_ENABLE_TEST_SUITE=OFF \
  -DHERMES_BUILD_APPLE_FRAMEWORK=OFF \
  -DHERMES_BUILD_SHARED_JSI=OFF \
  -DBUILD_SHARED_LIBS=OFF
cmake --build "$hermes_build_dir" --target hermes --parallel "$hermes_jobs"
hermes_binary="$hermes_build_dir/bin/hermes"
[[ -x $hermes_binary ]] || { echo 'Hermes runtime executable was not produced.' >&2; exit 1; }
[[ $(git -C "$hermes_source_dir" rev-parse HEAD) == "$hermes_source_commit" && -z $(git -C "$hermes_source_dir" status --porcelain) ]] || { echo 'Hermes source changed during the build.' >&2; exit 1; }
"$hermes_binary" --version

node - "$hermes_binary" "$hermes_source_commit" "$hermes_source_tag" "$hermes_source_repository" <<'NODE'
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const [binary, sourceCommit, sourceTag, sourceRepository] = process.argv.slice(2);
const build = {
  schemaVersion: 1, sourceCommit, sourceTag, sourceRepository,
  binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
  configuration: { buildType: 'Release', debugger: false, intl: false, target: 'hermes' },
};
writeFileSync(`${binary}.build-info.json`, JSON.stringify(build, null, 2) + '\n');
NODE
echo "Pinned Hermes runtime ready: $hermes_binary"
if [[ -n ${GITHUB_ENV:-} ]]; then
  printf 'HERMES_BIN=%s\n' "$hermes_binary" >> "$GITHUB_ENV"
fi
