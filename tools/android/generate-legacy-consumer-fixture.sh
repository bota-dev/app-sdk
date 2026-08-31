#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly REVISION="0f06d2a22c55e4976778520cce42230d23ca4226"
readonly BASELINE="$ROOT/protocol/baseline/android-sdk-0f06d2a-public-api.txt"
readonly OUTPUT="$ROOT/protocol/baseline/android-legacy-consumer-0f06d2a.jar"
readonly FIXTURE="$ROOT/tests/conformance/android-legacy-consumer"
readonly GRADLEW="$ROOT/platforms/android/gradlew"

legacy_path="${BOTA_LEGACY_ANDROID_PATH:-}"
while (($#)); do
  case "$1" in
    --legacy-path) legacy_path="${2:?--legacy-path requires a value}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$legacy_path" ]]; then
  echo "--legacy-path or BOTA_LEGACY_ANDROID_PATH is required" >&2
  exit 2
fi

"$ROOT/tools/android/capture-legacy-api.sh" --legacy-path "$legacy_path" --check "$BASELINE"
version="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$ROOT/sdk-version.toml")"
"$GRADLEW" -p "$ROOT/platforms/android" :sdk:publishMavenPublicationToLocalRepository >/dev/null
"$GRADLEW" -p "$FIXTURE" --refresh-dependencies \
  -PbotaSdkVersion="$version" \
  -PbotaSdkRepository="$ROOT/target/android-m2" \
  -PbotaLegacyMode=capture \
  -PbotaLegacyAar="$legacy_path/sdk/build/outputs/aar/sdk-release.aar" \
  :app:clean :app:compileDebugKotlin >/dev/null

classes="$FIXTURE/app/build/tmp/kotlin-classes/debug/dev/bota/legacy"
temporary="$(mktemp -d "$ROOT/target/android-legacy-consumer.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
mkdir -p "$temporary/dev/bota/legacy" "$temporary/META-INF"
cp "$classes"/FrozenLegacyConsumer*.class "$classes"/FrozenTransport.class "$temporary/dev/bota/legacy/"
baseline_sha="$(shasum -a 256 "$BASELINE" | awk '{print $1}')"
printf 'legacyRevision=%s\nbaselineSha256=%s\n' "$REVISION" "$baseline_sha" \
  > "$temporary/META-INF/bota-legacy-consumer.properties"
find "$temporary" -type f -exec touch -t 198001010000 {} +
rm -f "$OUTPUT" "$OUTPUT.sha256"
(cd "$temporary" && find . -type f -print | LC_ALL=C sort | zip -X -q "$OUTPUT" -@)
printf '%s  %s\n' "$(shasum -a 256 "$OUTPUT" | awk '{print $1}')" "$(basename "$OUTPUT")" \
  > "$OUTPUT.sha256"
"$ROOT/tools/android/verify-legacy-consumer-fixture.sh" "$OUTPUT"
echo "Generated frozen legacy consumer fixture at $OUTPUT"
