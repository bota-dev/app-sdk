#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AAR="${1:-$ROOT/platforms/android/sdk/build/outputs/aar/sdk-release.aar}"
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
NDK_ROOT="${ANDROID_NDK_HOME:-$ANDROID_SDK_ROOT/ndk/28.2.13676358}"
TOOLCHAIN="$(find "$NDK_ROOT/toolchains/llvm/prebuilt" -mindepth 1 -maxdepth 1 -type d -print -quit)"

if [[ ! -f "$AAR" ]]; then
  echo "AAR not found: $AAR" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
unzip -q "$AAR" -d "$work"

expected="$work/expected-native.txt"
actual="$work/actual-native.txt"
for abi in arm64-v8a armeabi-v7a x86_64 x86; do
  printf 'jni/%s/libbota_android_jni.so\n' "$abi"
  printf 'jni/%s/libbota_device_sdk_ffi.so\n' "$abi"
done | sort > "$expected"
find "$work/jni" -type f -name '*.so' \
  | sed "s#^$work/##" \
  | sort > "$actual"
diff -u "$expected" "$actual"

for library in $(cat "$actual"); do
  path="$work/$library"
  abi="$(cut -d/ -f2 <<< "$library")"
  case "$abi" in
    arm64-v8a) expected_machine="AArch64" ;;
    armeabi-v7a) expected_machine="ARM" ;;
    x86_64) expected_machine="Advanced Micro Devices X86-64" ;;
    x86) expected_machine="Intel 80386" ;;
    *) echo "Unexpected Android ABI: $abi" >&2; exit 1 ;;
  esac
  elf_header="$("$TOOLCHAIN/bin/llvm-readelf" --file-header "$path")"
  grep -q 'OS/ABI:.*UNIX - System V' <<< "$elf_header"
  grep -q "Machine:.*$expected_machine" <<< "$elf_header"
  if [[ "$abi" == "arm64-v8a" || "$abi" == "x86_64" ]]; then
    load_alignments="$("$TOOLCHAIN/bin/llvm-readelf" --program-headers "$path" \
      | awk '$1 == "LOAD" { print $NF }')"
    if [[ -z "$load_alignments" ]]; then
      echo "$library has no ELF load segments" >&2
      exit 1
    fi
    for alignment in $load_alignments; do
      if (( alignment < 0x4000 )); then
        echo "$library has a load segment aligned below 16 KiB: $alignment" >&2
        exit 1
      fi
    done
  fi
  elf_notes="$("$TOOLCHAIN/bin/llvm-readobj" --notes "$path")"
  grep -q '0000: 1A000000' <<< "$elf_notes"
  elf_dynamic="$("$TOOLCHAIN/bin/llvm-readelf" --dynamic-table "$path")"
  if [[ "$library" == */libbota_android_jni.so ]]; then
    grep -q 'Shared library: \[libbota_device_sdk_ffi.so\]' <<< "$elf_dynamic"
  fi
  library_strings="$(strings "$path")"
  if grep -Fq "$ROOT" <<< "$library_strings"; then
    echo "$library contains the checkout path" >&2
    exit 1
  fi
  if grep -Fq "$HOME/.cargo/registry" <<< "$library_strings"; then
    echo "$library contains the Cargo registry path" >&2
    exit 1
  fi
done

echo "AAR contains exactly two API-26-built native libraries for all four Android ABIs"
