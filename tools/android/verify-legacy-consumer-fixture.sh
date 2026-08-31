#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly REVISION="0f06d2a22c55e4976778520cce42230d23ca4226"
readonly BASELINE="$ROOT/protocol/baseline/android-sdk-0f06d2a-public-api.txt"
readonly FIXTURE="${1:-$ROOT/protocol/baseline/android-legacy-consumer-0f06d2a.jar}"

test -s "$FIXTURE"
test -s "$FIXTURE.sha256"
(cd "$(dirname "$FIXTURE")" && shasum -a 256 -c "$(basename "$FIXTURE").sha256")

expected="$(cat <<'EOF'
META-INF/bota-legacy-consumer.properties
dev/bota/legacy/FrozenLegacyConsumer$exerciseSuspendCalls$1.class
dev/bota/legacy/FrozenLegacyConsumer.class
dev/bota/legacy/FrozenTransport.class
EOF
)"
actual="$(unzip -Z1 "$FIXTURE" | sed 's#^\./##')"
test "$actual" = "$expected"

temporary="$(mktemp -d "${TMPDIR:-/tmp}/bota-legacy-consumer.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
unzip -qq "$FIXTURE" META-INF/bota-legacy-consumer.properties -d "$temporary"
baseline_sha="$(shasum -a 256 "$BASELINE" | awk '{print $1}')"
grep -Fx "legacyRevision=$REVISION" "$temporary/META-INF/bota-legacy-consumer.properties"
grep -Fx "baselineSha256=$baseline_sha" "$temporary/META-INF/bota-legacy-consumer.properties"
javap -classpath "$FIXTURE" -c dev.bota.legacy.FrozenLegacyConsumer \
  | grep -F 'com/bota/sdk/' >/dev/null
if grep -a -E '/(Users|private|home)/' "$FIXTURE" >/dev/null; then
  echo "Frozen legacy consumer contains a local path" >&2
  exit 1
fi
echo "Frozen legacy consumer fixture matches revision and API baseline"
