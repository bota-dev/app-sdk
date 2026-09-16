#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
WEB_DIR="$ROOT_DIR/frameworks/web"
CONSUMER_DIR="$ROOT_DIR/tests/consumers/web-vite"
RELEASE_DIR="$ROOT_DIR/target/web-release"

mkdir -p "$RELEASE_DIR"
find "$RELEASE_DIR" -mindepth 1 -maxdepth 1 -type f -delete

npm run build --prefix "$WEB_DIR"
(
  cd "$WEB_DIR"
  npm pack --json --pack-destination "$RELEASE_DIR" >/dev/null
)

TARBALL_COUNT="$(find "$RELEASE_DIR" -mindepth 1 -maxdepth 1 -type f -name '*.tgz' | wc -l | tr -d ' ')"
if [[ "$TARBALL_COUNT" != "1" ]]; then
  echo "expected exactly one packed Web SDK tarball, found $TARBALL_COUNT" >&2
  exit 1
fi
TARBALL="$(find "$RELEASE_DIR" -mindepth 1 -maxdepth 1 -type f -name '*.tgz' -print)"

node "$ROOT_DIR/tools/web/verify-package.mjs" "$TARBALL"
npm ci --prefix "$CONSUMER_DIR"
npm install --prefix "$CONSUMER_DIR" --no-save "$TARBALL"
npm run build --prefix "$CONSUMER_DIR"
