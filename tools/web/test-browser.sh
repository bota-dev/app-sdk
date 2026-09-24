#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
CONSUMER_DIR="$ROOT_DIR/tests/consumers/web-vite"
RELEASE_DIR="$ROOT_DIR/target/web-release"
TARBALL="${1:-}"
INVENTORY="${2:-$RELEASE_DIR/web-package-files.json}"
INVENTORY_CHECKSUM="${3:-$INVENTORY.sha256}"

if [[ -z "$TARBALL" ]]; then
  TARBALL_COUNT="$(find "$RELEASE_DIR" -mindepth 1 -maxdepth 1 -type f -name '*.tgz' | wc -l | tr -d ' ')"
  if [[ "$TARBALL_COUNT" != "1" ]]; then
    echo "expected exactly one packed Web SDK tarball, found $TARBALL_COUNT" >&2
    exit 1
  fi
  TARBALL="$(find "$RELEASE_DIR" -mindepth 1 -maxdepth 1 -type f -name '*.tgz' -print)"
fi

TARBALL="$(cd "$(dirname "$TARBALL")" && pwd -P)/$(basename "$TARBALL")"
if [[ ! -f "$TARBALL" ]]; then
  echo "Web SDK tarball does not exist: $TARBALL" >&2
  exit 1
fi

INSTALLED_PACKAGE="$CONSUMER_DIR/node_modules/@bota.dev/web-app-sdk"
if [[ ! -d "$INSTALLED_PACKAGE" || -L "$INSTALLED_PACKAGE" ]]; then
  echo "packed Web SDK is not installed as a regular consumer package" >&2
  exit 1
fi

node "$ROOT_DIR/tools/web/verify-installed-package.mjs" \
  "$TARBALL" \
  "$INVENTORY" \
  "$INVENTORY_CHECKSUM" \
  "$INSTALLED_PACKAGE"

export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$ROOT_DIR/target/playwright-browsers}"
npm run test:browser --prefix "$CONSUMER_DIR"
