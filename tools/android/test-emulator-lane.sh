#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly ANDROID_SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
readonly ADB="$ANDROID_SDK/platform-tools/adb"
readonly EMULATOR="$ANDROID_SDK/emulator/emulator"
readonly AVDMANAGER="$ANDROID_SDK/cmdline-tools/latest/bin/avdmanager"

api=""
repository="$ROOT/target/android-m2"
release_directory="$ROOT/target/android-release"
public_only=false
while (($#)); do
  case "$1" in
    --api) api="${2:?--api requires a value}"; shift 2 ;;
    --repository) repository="${2:?--repository requires a value}"; shift 2 ;;
    --release-directory) release_directory="${2:?--release-directory requires a value}"; shift 2 ;;
    --public-only) public_only=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$api" in
  26)
    image="system-images;android-26;google_apis;x86"
    avd="bota-api-26"
    ;;
  35)
    image="system-images;android-35;google_apis;x86_64"
    avd="bota-api-35"
    ;;
  *)
    echo "--api must be 26 or 35" >&2
    exit 2
    ;;
esac
for tool in "$ADB" "$EMULATOR" "$AVDMANAGER"; do test -x "$tool"; done

emulator_pid=""
cleanup() {
  "$ADB" emu kill >/dev/null 2>&1 || true
  if [[ -n "$emulator_pid" ]]; then wait "$emulator_pid" 2>/dev/null || true; fi
  "$AVDMANAGER" delete avd --name "$avd" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

"$AVDMANAGER" delete avd --name "$avd" >/dev/null 2>&1 || true
printf 'no\n' | "$AVDMANAGER" create avd --force --name "$avd" --package "$image"
"$EMULATOR" -avd "$avd" -no-window -no-audio -no-boot-anim -no-snapshot -wipe-data &
emulator_pid=$!
"$ADB" wait-for-device
for _ in $(seq 1 180); do
  if [[ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; then break; fi
  sleep 2
done
test "$("$ADB" shell getprop sys.boot_completed | tr -d '\r')" = "1"
"$ADB" shell settings put global window_animation_scale 0
"$ADB" shell settings put global transition_animation_scale 0
"$ADB" shell settings put global animator_duration_scale 0

for package in dev.bota.sdk.test dev.bota.example dev.bota.example.test dev.bota.legacy dev.bota.legacy.test; do
  "$ADB" uninstall "$package" >/dev/null 2>&1 || true
done

if [[ "$public_only" == true ]]; then
  "$ROOT/tools/android/test-consumer.sh" --api "$api" --public
  exit 0
fi

version="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$ROOT/sdk-version.toml")"
release_aar="$release_directory/bota-android-sdk-$version.aar"
repository_aar="$repository/dev/bota/bota-android-sdk/$version/bota-android-sdk-$version.aar"
release_digest="$(shasum -a 256 "$release_aar" | awk '{print $1}')"
test "$release_digest" = "$(shasum -a 256 "$repository_aar" | awk '{print $1}')"

instrumentation_classes="dev.bota.sdk.internal.bluetooth.BluetoothPermissionTest,dev.bota.sdk.internal.jni.NativeCoreBridgeTest,dev.bota.sdk.internal.core.ProtocolCodecTest,dev.bota.sdk.internal.core.WorkflowConformanceTest,dev.bota.sdk.internal.host.AtomicFilePersistenceHostTest,dev.bota.sdk.internal.host.AndroidFileHostTest,dev.bota.sdk.internal.host.KeystoreHostTest"
"$ROOT/tools/android/test-package.sh" --api "$api" --skip-build \
  --instrumentation-class "$instrumentation_classes"
"$ROOT/tools/android/test-legacy-consumer.sh" --api "$api" --mode source \
  --repository "$repository"
"$ROOT/tools/android/test-legacy-consumer.sh" --api "$api" --mode binary \
  --repository "$repository"
"$ROOT/tools/android/test-consumer.sh" --api "$api" --repository "$repository"

test "$release_digest" = "$(shasum -a 256 "$release_aar" | awk '{print $1}')"
test "$release_digest" = "$(shasum -a 256 "$repository_aar" | awk '{print $1}')"
