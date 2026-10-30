#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"
swift run --package-path platforms/watch "$@" -Xswiftc -warnings-as-errors WatchControlChecks
# Offline source verification. The root-package consumer has a separate gate.
BOTA_WATCH_SDK_PATH="$repo_root/platforms/watch" swift run \
  --package-path tests/consumers/watch-control "$@" \
  -Xswiftc -warnings-as-errors WatchControlConsumer
