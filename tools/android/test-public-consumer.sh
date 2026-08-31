#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

api=""
while (($#)); do
  case "$1" in
    --api) api="${2:?--api requires a value}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ "$api" != "26" && "$api" != "35" ]]; then
  echo "--api must be 26 or 35" >&2
  exit 2
fi

"$ROOT/tools/android/test-emulator-lane.sh" --api "$api" --public-only
