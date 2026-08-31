#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_REVISION="0f06d2a22c55e4976778520cce42230d23ca4226"
readonly REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly DEFAULT_BASELINE="$REPOSITORY_ROOT/protocol/baseline/android-sdk-0f06d2a-public-api.txt"

legacy_path=""
check_path=""
output_path="$DEFAULT_BASELINE"

usage() {
  cat <<'EOF'
Usage: capture-legacy-api.sh --legacy-path PATH [--output FILE | --check FILE]

Builds the pinned legacy Android SDK and emits a deterministic public JVM API
inventory. --check compares the generated inventory without modifying FILE.
EOF
}

while (($#)); do
  case "$1" in
    --legacy-path)
      legacy_path="${2:?--legacy-path requires a value}"
      shift 2
      ;;
    --output)
      output_path="${2:?--output requires a value}"
      shift 2
      ;;
    --check)
      check_path="${2:?--check requires a value}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$legacy_path" ]]; then
  echo "--legacy-path is required" >&2
  exit 2
fi

legacy_path="$(cd "$legacy_path" && pwd)"
actual_revision="$(git -C "$legacy_path" rev-parse HEAD)"
if [[ "$actual_revision" != "$EXPECTED_REVISION" ]]; then
  echo "Legacy checkout must be at $EXPECTED_REVISION, found $actual_revision" >&2
  exit 1
fi
if [[ -n "$(git -C "$legacy_path" status --porcelain --untracked-files=all)" ]]; then
  echo "Legacy checkout must be clean: $legacy_path" >&2
  exit 1
fi

"$legacy_path/gradlew" -p "$legacy_path" :sdk:assembleRelease >/dev/null

aar="$legacy_path/sdk/build/outputs/aar/sdk-release.aar"
if [[ ! -f "$aar" ]]; then
  echo "Legacy build did not produce $aar" >&2
  exit 1
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/bota-legacy-api.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT
unzip -qq "$aar" classes.jar -d "$tmp_dir"

inventory="$tmp_dir/public-api.txt"
{
  printf '# Bota legacy Android SDK public JVM API\n'
  printf '# Revision: %s\n' "$EXPECTED_REVISION"
  printf '# Command: javap -public -s -constants\n\n'
  unzip -Z1 "$tmp_dir/classes.jar" \
    | LC_ALL=C sort \
    | awk '
        /^com\/bota\/sdk\/[A-Za-z0-9_]+\.class$/ && $0 !~ /BotaProtocolKt\.class$/ { print; next }
        /^com\/bota\/sdk\/BluetoothTransport\$DefaultImpls\.class$/ { print; next }
        /^com\/bota\/sdk\/BotaClient\$Companion\.class$/ { print; next }
        /^com\/bota\/sdk\/BotaSdkException\$(BluetoothUnavailable|NotConnected|NotInitialized|UnsupportedOperation)\.class$/ { print }
      ' \
    | while IFS= read -r entry; do
        class_name="${entry%.class}"
        class_name="${class_name//\//.}"
        printf '===== %s =====\n' "$class_name"
        LC_ALL=C javap -classpath "$tmp_dir/classes.jar" -public -s -constants "$class_name"
        printf '\n'
      done
} >"$inventory"
perl -0pi -e 's/\n+\z/\n/' "$inventory"

if [[ -n "$check_path" ]]; then
  if ! cmp -s "$inventory" "$check_path"; then
    echo "Legacy API inventory differs from $check_path" >&2
    diff -u "$check_path" "$inventory" || true
    exit 1
  fi
  echo "Legacy Android API inventory matches $check_path"
  exit 0
fi

mkdir -p "$(dirname "$output_path")"
cp "$inventory" "$output_path"
echo "Wrote legacy Android API inventory to $output_path"
