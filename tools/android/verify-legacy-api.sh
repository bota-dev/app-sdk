#!/usr/bin/env bash
set -euo pipefail

readonly REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly BASELINE="$REPOSITORY_ROOT/protocol/baseline/android-sdk-0f06d2a-public-api.txt"
readonly FROZEN_CONSUMER="$REPOSITORY_ROOT/tests/conformance/android-legacy-consumer/app/src/main/kotlin/dev/bota/legacy/FrozenLegacyConsumer.kt"

legacy_path="${BOTA_LEGACY_ANDROID_PATH:-}"
while (($#)); do
  case "$1" in
    --legacy-path)
      legacy_path="${2:?--legacy-path requires a value}"
      shift 2
      ;;
    -h|--help)
      echo "Usage: verify-legacy-api.sh --legacy-path PATH"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$legacy_path" ]]; then
  echo "--legacy-path or BOTA_LEGACY_ANDROID_PATH is required" >&2
  exit 2
fi

"$REPOSITORY_ROOT/tools/android/capture-legacy-api.sh" \
  --legacy-path "$legacy_path" \
  --check "$BASELINE"

if command -v sha256sum >/dev/null 2>&1; then
  baseline_sha="$(sha256sum "$BASELINE" | awk '{print $1}')"
else
  baseline_sha="$(shasum -a 256 "$BASELINE" | awk '{print $1}')"
fi
if ! grep -q "^// Baseline-SHA256: $baseline_sha$" "$FROZEN_CONSUMER"; then
  echo "Frozen legacy consumer was not reviewed against baseline SHA-256 $baseline_sha" >&2
  exit 1
fi

"$REPOSITORY_ROOT/platforms/android/gradlew" \
  -p "$REPOSITORY_ROOT/platforms/android" \
  :sdk:assembleRelease >/dev/null

aar="$REPOSITORY_ROOT/platforms/android/sdk/build/outputs/aar/sdk-release.aar"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/bota-legacy-verify.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT
unzip -qq "$aar" classes.jar -d "$tmp_dir"

replacement="$tmp_dir/replacement-api.txt"
while IFS= read -r class_name; do
  printf '===== %s =====\n' "$class_name" >>"$replacement"
  LC_ALL=C javap -classpath "$tmp_dir/classes.jar" -public -s -constants "$class_name" >>"$replacement"
  printf '\n' >>"$replacement"
done < <(awk '/^===== / { print $2 }' "$BASELINE")

normalize() {
  awk '
    /^===== / { class_name = $2; print "CLASS|" class_name; next }
    /^  public / {
      signature = $0
      sub(/ = .*;$/, ";", signature)
      next
    }
    /^    descriptor: / {
      if (signature != "") print class_name "|" signature "|" $0
      signature = ""
    }
  ' "$1" | LC_ALL=C sort -u
}

normalize "$BASELINE" >"$tmp_dir/required.txt"
normalize "$replacement" >"$tmp_dir/replacement.txt"

missing="$tmp_dir/missing.txt"
comm -23 "$tmp_dir/required.txt" "$tmp_dir/replacement.txt" >"$missing"
if [[ -s "$missing" ]]; then
  echo "Replacement AAR is missing legacy JVM signatures:" >&2
  cat "$missing" >&2
  exit 1
fi

echo "Replacement AAR preserves every frozen com.bota.sdk JVM signature"
