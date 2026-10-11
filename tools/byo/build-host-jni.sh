#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
output="${1:?Usage: build-host-jni.sh OUTPUT_DIRECTORY}"
: "${JAVA_HOME:?Set JAVA_HOME to the JDK used by Gradle tests}"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
cd "$repo_root"
host_target="$(rustc -vV | sed -n 's/^host: //p')"
[[ -n "$host_target" ]] || { echo 'Cannot determine Rust host target' >&2; exit 1; }
cargo build --locked -p bota-device-sdk-ffi --target "$host_target" --target-dir "$repo_root/target/byo-host"

case "$(uname -s)" in
  Darwin) platform=darwin; extension=dylib; linker=(-dynamiclib '-Wl,-rpath,@loader_path') ;;
  Linux) platform=linux; extension=so; linker=(-shared -fPIC '-Wl,-rpath,$ORIGIN') ;;
  *) echo 'Host JNI tests require macOS or Linux' >&2; exit 1 ;;
esac
cp "$repo_root/target/byo-host/$host_target/debug/libbota_device_sdk_ffi.$extension" "$output/"
"${CXX:-c++}" -std=c++17 -Wall -Wextra -Werror -DBOTA_ANDROID_JNI_TESTING=1 \
  -I"$JAVA_HOME/include" -I"$JAVA_HOME/include/$platform" \
  -I"$repo_root/bindings/device-sdk-ffi/include" \
  "$repo_root/platforms/android/sdk/src/main/cpp/bota_android_jni.cpp" \
  -L"$output" -lbota_device_sdk_ffi "${linker[@]}" \
  -o "$output/libbota_android_jni.$extension"
