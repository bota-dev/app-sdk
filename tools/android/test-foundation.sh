#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
android_root="$repo_root/platforms/android"
gradlew="$android_root/gradlew"
evidence_dir="$repo_root/target/android-foundation"

mkdir -p "$evidence_dir"
unset ORG_GRADLE_PROJECT_signingInMemoryKey
unset ORG_GRADLE_PROJECT_signingInMemoryKeyPassword
unset ORG_GRADLE_PROJECT_signingInMemoryKeyId

if [[ -n "${JAVA_HOME:-}" ]]; then
    java_bin="$JAVA_HOME/bin/java"
else
    java_bin="$(command -v java)"
fi
java_major="$("$java_bin" -XshowSettings:properties -version 2>&1 \
    | awk -F= '/java.specification.version/ { gsub(/[[:space:]]/, "", $2); print $2; exit }')"
if [[ "$java_major" != "17" ]]; then
    echo "Android foundation requires JDK 17, found ${java_major:-unknown}" >&2
    exit 1
fi

(cd "$repo_root" && cargo test -p xtask --test release_readiness)

"$gradlew" -p "$android_root" --version

override_log="$evidence_dir/version-override.log"
if "$gradlew" -p "$android_root" -PVERSION_NAME=9.9.9 help >"$override_log" 2>&1; then
    echo "Android build accepted a VERSION_NAME override" >&2
    exit 1
fi
grep -q "does not match sdk-version.toml" "$override_log"

tasks_log="$evidence_dir/publication-tasks.txt"
"$gradlew" -p "$android_root" :sdk:tasks --all >"$tasks_log"
for task in \
    publishToMavenLocal \
    publishToMavenCentral \
    publishAndReleaseToMavenCentral \
    publishAllPublicationsToMavenCentralRepository \
    publishMavenPublicationToLocalRepository \
    stageSignedCentralRawRepository
do
    grep -Eq "^${task} - " "$tasks_log"
done

for task in signMavenPublication publishMavenPublicationToCentralRawRepository
do
    if grep -Eq "^${task} - " "$tasks_log"; then
        echo "Protected task ${task} is present without protected signing" >&2
        exit 1
    fi
done

"$gradlew" -p "$android_root" \
    :sdk:testDebugUnitTest \
    :sdk:lintRelease \
    :sdk:assembleRelease \
    :sdk:publishMavenPublicationToLocalRepository
