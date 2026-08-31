#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
GRADLE="$ROOT/platforms/android/gradlew"
ANDROID_PROJECT="$ROOT/platforms/android"
LOCAL_REPOSITORY="$ROOT/target/android-m2"
RAW_REPOSITORY="$ROOT/target/android-central-raw"
PORTAL_REPOSITORY="$ROOT/target/android-central-portal"
RELEASE_DIRECTORY="$ROOT/target/android-release"
SDK_VERSION=$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$ROOT/sdk-version.toml")
GPG=${GPG:-gpg}

test -n "$SDK_VERSION"
command -v "$GPG" >/dev/null
unset ORG_GRADLE_PROJECT_signingInMemoryKey
unset ORG_GRADLE_PROJECT_signingInMemoryKeyPassword
unset ORG_GRADLE_PROJECT_signingInMemoryKeyId
rm -rf "$LOCAL_REPOSITORY" "$RAW_REPOSITORY" "$PORTAL_REPOSITORY" "$RELEASE_DIRECTORY"

DEFAULT_TASKS=$(mktemp)
MISSING_LOG=$(mktemp)
GNUPGHOME=$(mktemp -d)
FIRST_ZIP=$(mktemp)
cleanup() {
    unset ORG_GRADLE_PROJECT_signingInMemoryKey
    unset ORG_GRADLE_PROJECT_signingInMemoryKeyPassword
    unset ORG_GRADLE_PROJECT_signingInMemoryKeyId
    rm -f "$DEFAULT_TASKS" "$MISSING_LOG" "$FIRST_ZIP"
    rm -rf "$GNUPGHOME"
}
trap cleanup EXIT HUP INT TERM
chmod 700 "$GNUPGHOME"

"$GRADLE" -p "$ANDROID_PROJECT" :sdk:tasks --all --no-daemon --no-parallel --no-configuration-cache > "$DEFAULT_TASKS"
if grep -F 'signMavenPublication' "$DEFAULT_TASKS" >/dev/null \
    || grep -F 'publishMavenPublicationToCentralRawRepository' "$DEFAULT_TASKS" >/dev/null; then
    printf 'unsigned task graph exposes protected signing or staging tasks\n' >&2
    exit 1
fi
"$GRADLE" -p "$ANDROID_PROJECT" :sdk:publishMavenPublicationToLocalRepository \
    --no-daemon --no-parallel --no-configuration-cache
if find "$LOCAL_REPOSITORY" -type f -name '*.asc' -print -quit | grep . >/dev/null; then
    printf 'unsigned local repository contains a signature\n' >&2
    exit 1
fi

if "$GRADLE" -p "$ANDROID_PROJECT" -PbotaProtectedSigning=true :sdk:stageSignedCentralRawRepository \
    --no-daemon --no-parallel --no-configuration-cache > "$MISSING_LOG" 2>&1; then
    printf 'protected staging unexpectedly succeeded without signing material\n' >&2
    exit 1
fi
grep -F 'protected Android staging requires in-memory signing key and password' "$MISSING_LOG" >/dev/null
if [ -d "$RAW_REPOSITORY" ] && find "$RAW_REPOSITORY" -mindepth 1 -print -quit | grep . >/dev/null; then
    printf 'protected staging created raw output before validating signing material\n' >&2
    exit 1
fi
if "$GRADLE" -p "$ANDROID_PROJECT" -PbotaProtectedSigning=false help \
    --no-daemon --no-parallel --no-configuration-cache > "$MISSING_LOG" 2>&1; then
    printf 'non-exact protected signing value unexpectedly succeeded\n' >&2
    exit 1
fi
grep -F 'botaProtectedSigning must be exactly true' "$MISSING_LOG" >/dev/null

PASSPHRASE="bota-ephemeral-$SDK_VERSION"
IDENTITY="Bota Android Ephemeral Release Test <$SDK_VERSION@invalid.bota.dev>"
"$GPG" --homedir "$GNUPGHOME" --batch --pinentry-mode loopback --passphrase "$PASSPHRASE" \
    --quick-generate-key "$IDENTITY" rsa2048 sign 1d >/dev/null 2>&1
FINGERPRINT=$("$GPG" --homedir "$GNUPGHOME" --batch --with-colons --list-secret-keys "$IDENTITY" \
    | awk -F: '$1 == "fpr" { print $10; exit }')
test -n "$FINGERPRINT"
SIGNING_KEY=$("$GPG" --homedir "$GNUPGHOME" --batch --pinentry-mode loopback --passphrase "$PASSPHRASE" \
    --armor --export-secret-keys "$FINGERPRINT")

ORG_GRADLE_PROJECT_signingInMemoryKey="$SIGNING_KEY" \
ORG_GRADLE_PROJECT_signingInMemoryKeyPassword="$PASSPHRASE" \
"$GRADLE" -p "$ANDROID_PROJECT" -PbotaProtectedSigning=true :sdk:stageSignedCentralRawRepository \
    --no-daemon --no-parallel --no-configuration-cache

VERSION_DIRECTORY="$RAW_REPOSITORY/dev/bota/bota-android-sdk/$SDK_VERSION"
for name in \
    "bota-android-sdk-$SDK_VERSION.aar" \
    "bota-android-sdk-$SDK_VERSION.pom" \
    "bota-android-sdk-$SDK_VERSION.module" \
    "bota-android-sdk-$SDK_VERSION-sources.jar" \
    "bota-android-sdk-$SDK_VERSION-javadoc.jar"
do
    "$GPG" --homedir "$GNUPGHOME" --batch --verify "$VERSION_DIRECTORY/$name.asc" "$VERSION_DIRECTORY/$name" >/dev/null 2>&1
done
RAW_COUNT=$(find "$RAW_REPOSITORY" -type f | wc -l | tr -d ' ')
test "$RAW_COUNT" = 55

node "$ROOT/tools/android/normalize-central-repository.mjs" \
    --raw-repository "$RAW_REPOSITORY" \
    --portal-repository "$PORTAL_REPOSITORY" \
    --coordinate dev.bota:bota-android-sdk \
    --version "$SDK_VERSION"
node "$ROOT/tools/android/build-central-bundle.mjs" build \
    --repository "$PORTAL_REPOSITORY" \
    --coordinate dev.bota:bota-android-sdk \
    --version "$SDK_VERSION" \
    --source-revision "$(git -C "$ROOT" rev-parse HEAD)" \
    --inventory "$RELEASE_DIRECTORY/central-bundle-files.json" \
    --output "$RELEASE_DIRECTORY/central-bundle.zip"
cp "$RELEASE_DIRECTORY/central-bundle.zip" "$FIRST_ZIP"
node "$ROOT/tools/android/build-central-bundle.mjs" build \
    --repository "$PORTAL_REPOSITORY" \
    --coordinate dev.bota:bota-android-sdk \
    --version "$SDK_VERSION" \
    --source-revision "$(git -C "$ROOT" rev-parse HEAD)" \
    --inventory "$RELEASE_DIRECTORY/central-bundle-files.json" \
    --output "$RELEASE_DIRECTORY/central-bundle.zip"
cmp "$FIRST_ZIP" "$RELEASE_DIRECTORY/central-bundle.zip"
node "$ROOT/tools/android/build-central-bundle.mjs" verify \
    --repository "$PORTAL_REPOSITORY" \
    --inventory "$RELEASE_DIRECTORY/central-bundle-files.json" \
    --zip "$RELEASE_DIRECTORY/central-bundle.zip"
unzip -Z1 "$RELEASE_DIRECTORY/central-bundle.zip" | LC_ALL=C sort > "$RELEASE_DIRECTORY/zip-files.txt"
node -e 'const value = require(process.argv[1]); process.stdout.write(value.files.map((entry) => entry.path).sort().join("\n") + "\n")' \
    "$RELEASE_DIRECTORY/central-bundle-files.json" > "$RELEASE_DIRECTORY/inventory-files.txt"
cmp "$RELEASE_DIRECTORY/zip-files.txt" "$RELEASE_DIRECTORY/inventory-files.txt"
rm "$RELEASE_DIRECTORY/zip-files.txt" "$RELEASE_DIRECTORY/inventory-files.txt"

printf 'Android publication graphs verified for %s\n' "$SDK_VERSION"
