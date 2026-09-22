#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
WEB_DIR="$ROOT_DIR/frameworks/web"
CONSUMER_DIR="$ROOT_DIR/tests/consumers/web-vite"
RELEASE_DIR="$ROOT_DIR/target/web-release"
NPM_CACHE_DIR="$ROOT_DIR/target/web-npm-cache"
NPM_CLI_VERSION="12.0.2"

rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR" "$NPM_CACHE_DIR"

npm run build --prefix "$WEB_DIR"
(
  cd "$WEB_DIR"
  npm_config_cache="$NPM_CACHE_DIR" \
    npx --yes "npm@$NPM_CLI_VERSION" pack --json \
      --pack-destination "$RELEASE_DIR" >/dev/null
)

TARBALL_COUNT="$(find "$RELEASE_DIR" -mindepth 1 -maxdepth 1 -type f -name '*.tgz' | wc -l | tr -d ' ')"
if [[ "$TARBALL_COUNT" != "1" ]]; then
  echo "expected exactly one packed Web SDK tarball, found $TARBALL_COUNT" >&2
  exit 1
fi
TARBALL="$(find "$RELEASE_DIR" -mindepth 1 -maxdepth 1 -type f -name '*.tgz' -print)"
INVENTORY="$RELEASE_DIR/web-package-files.json"

node "$ROOT_DIR/tools/web/verify-package.mjs" "$TARBALL" \
  --inventory "$INVENTORY"
npm_config_cache="$NPM_CACHE_DIR" \
  npx --yes "npm@$NPM_CLI_VERSION" ci --prefix "$CONSUMER_DIR"
npm_config_cache="$NPM_CACHE_DIR" \
  npx --yes "npm@$NPM_CLI_VERSION" install --prefix "$CONSUMER_DIR" \
    --no-save --package-lock=false "$TARBALL"
npm run build --prefix "$CONSUMER_DIR"
"$ROOT_DIR/tools/web/test-browser.sh" \
  "$TARBALL" \
  "$INVENTORY" \
  "$INVENTORY.sha256"
