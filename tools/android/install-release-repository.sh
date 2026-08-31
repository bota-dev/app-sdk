#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly RELEASE_DIRECTORY="${1:-$ROOT/target/android-release}"
readonly REPOSITORY="${2:-$ROOT/target/android-m2}"
readonly VERSION="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$ROOT/sdk-version.toml")"
readonly DESTINATION="$REPOSITORY/dev/bota/bota-android-sdk/$VERSION"

"$ROOT/tools/android/verify-publication.sh" "$RELEASE_DIRECTORY"
rm -rf "$REPOSITORY"
mkdir -p "$DESTINATION"
cp "$RELEASE_DIRECTORY"/bota-android-sdk-"$VERSION"* "$DESTINATION/"
test -s "$DESTINATION/bota-android-sdk-$VERSION.aar"
echo "Installed Android release payload into $REPOSITORY"
