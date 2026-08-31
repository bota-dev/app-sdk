#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELEASE_DIRECTORY="${1:-}"
SDK_VERSION="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$ROOT/sdk-version.toml")"
SOURCE_REVISION="$(git -C "$ROOT" rev-parse HEAD)"
NODE="${NODE:-node}"

if [[ -z "$RELEASE_DIRECTORY" || ! -d "$RELEASE_DIRECTORY" ]]; then
  echo "usage: $0 <android-release-directory>" >&2
  exit 2
fi
RELEASE_DIRECTORY="$(cd "$RELEASE_DIRECTORY" && pwd)"
EXPECTED_FILE_COUNT=28
ACTUAL_FILE_COUNT="$(find "$RELEASE_DIRECTORY" -maxdepth 1 -type f | wc -l | tr -d ' ')"
if [[ "$ACTUAL_FILE_COUNT" != "$EXPECTED_FILE_COUNT" ]]; then
  echo "Android release directory must contain exactly $EXPECTED_FILE_COUNT files, found $ACTUAL_FILE_COUNT" >&2
  exit 1
fi

verify_checksum() {
  local file="$1"
  local algorithm="$2"
  local expected actual
  expected="$(tr -d '[:space:]' < "$file.$algorithm")"
  actual="$(openssl dgst "-$algorithm" -r "$file" | awk '{print $1}')"
  if [[ -z "$expected" || "$expected" != "$actual" ]]; then
    echo "$algorithm checksum mismatch for $(basename "$file")" >&2
    exit 1
  fi
}

for name in \
  "bota-android-sdk-$SDK_VERSION.aar" \
  "bota-android-sdk-$SDK_VERSION.pom" \
  "bota-android-sdk-$SDK_VERSION.module" \
  "bota-android-sdk-$SDK_VERSION-sources.jar" \
  "bota-android-sdk-$SDK_VERSION-javadoc.jar"
do
  test -s "$RELEASE_DIRECTORY/$name"
  for algorithm in md5 sha1 sha256 sha512; do
    test -s "$RELEASE_DIRECTORY/$name.$algorithm"
    verify_checksum "$RELEASE_DIRECTORY/$name" "$algorithm"
  done
done
test -s "$RELEASE_DIRECTORY/LICENSE"
test -s "$RELEASE_DIRECTORY/BotaAndroidSDK.spdx.json"
test -s "$RELEASE_DIRECTORY/release-manifest.json"
cmp "$ROOT/LICENSE" "$RELEASE_DIRECTORY/LICENSE"

"$NODE" "$ROOT/tools/android/normalize-central-repository.mjs" verify-maven \
  --repository "$RELEASE_DIRECTORY" \
  --coordinate dev.bota:bota-android-sdk \
  --version "$SDK_VERSION"
"$ROOT/tools/android/inspect-aar.sh" "$RELEASE_DIRECTORY/bota-android-sdk-$SDK_VERSION.aar"
(cd "$ROOT" && cargo xtask release validate "$RELEASE_DIRECTORY/release-manifest.json")

"$NODE" -e '
  const [sbomPath, manifestPath, version, revision] = process.argv.slice(1);
  const sbom = require(sbomPath);
  const manifest = require(manifestPath);
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const aar = `${require("node:path").dirname(sbomPath)}/bota-android-sdk-${version}.aar`;
  const checksum = crypto.createHash("sha256").update(fs.readFileSync(aar)).digest("hex");
  const sbomAar = sbom.files.find((entry) => entry.fileName === `bota-android-sdk-${version}.aar`);
  if (sbom.spdxVersion !== "SPDX-2.3" || sbom.name !== `BotaAndroidSDK-${version}`
      || sbomAar?.checksums?.[0]?.checksumValue !== checksum) throw new Error("invalid Android SBOM");
  const artifact = manifest.artifacts.find((entry) => entry.platform === "android");
  if (manifest.manifestVersion !== 2 || manifest.sourceRevision !== revision
      || artifact?.packageIdentifier !== "dev.bota:bota-android-sdk"
      || artifact?.version !== version || artifact?.ecosystem !== "maven"
      || artifact?.checksumSha256 !== checksum) throw new Error("invalid Android release manifest");
' "$RELEASE_DIRECTORY/BotaAndroidSDK.spdx.json" "$RELEASE_DIRECTORY/release-manifest.json" "$SDK_VERSION" "$SOURCE_REVISION"

if grep -R -F "$ROOT" "$RELEASE_DIRECTORY" >/dev/null \
  || grep -R -E '/(Users|private|home)/' "$RELEASE_DIRECTORY" >/dev/null; then
  echo "Android release output contains a local path" >&2
  exit 1
fi
echo "Verified Android publication directory for $SDK_VERSION"
