#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

export BOTA_FLUTTER_DISPATCH_DART=1
exec "$ROOT/tools/flutter/run-flutter.sh" "$@"
