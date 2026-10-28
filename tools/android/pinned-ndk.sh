#!/usr/bin/env bash
# Sourced by build/inspection: reject a different inherited runner NDK.
NDK_VERSION="28.2.13676358"
NDK_ROOT="${ANDROID_NDK_HOME:-$ANDROID_SDK_ROOT/ndk/$NDK_VERSION}"
if [[ ! -f "$NDK_ROOT/source.properties" ]] || \
    [[ "$(sed -n 's/^Pkg.Revision[[:space:]]*=[[:space:]]*//p' "$NDK_ROOT/source.properties")" != "$NDK_VERSION" ]]; then
  NDK_ROOT="$ANDROID_SDK_ROOT/ndk/$NDK_VERSION"
fi
if [[ ! -f "$NDK_ROOT/source.properties" ]] || \
    [[ "$(sed -n 's/^Pkg.Revision[[:space:]]*=[[:space:]]*//p' "$NDK_ROOT/source.properties")" != "$NDK_VERSION" ]]; then
  echo "Exact Android NDK $NDK_VERSION was not found at $NDK_ROOT" >&2
  exit 1
fi
case "$(uname -s)" in
  Linux) ndk_host="linux-x86_64" ;;
  Darwin) ndk_host="darwin-x86_64" ;;
  *) echo "Unsupported NDK host" >&2; exit 1 ;;
esac
TOOLCHAIN="$NDK_ROOT/toolchains/llvm/prebuilt/$ndk_host"
test -x "$TOOLCHAIN/bin/llvm-readelf"
echo "Using exact Android NDK $NDK_VERSION: $TOOLCHAIN"
