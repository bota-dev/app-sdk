#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG="$ROOT/tools/flutter/flutter-version.json"
PACKAGE_PATH="frameworks/flutter/bota_flutter_sdk"
PACKAGE_ROOT="$ROOT/$PACKAGE_PATH"

config_value() {
  node -e '
    const config = require(process.argv[1]);
    const value = process.argv[2].split(".").reduce((current, key) => current?.[key], config);
    if (typeof value !== "string" || value.length === 0) process.exit(1);
    process.stdout.write(value);
  ' "$CONFIG" "$1"
}

VERSION="$(config_value version)"
DART_VERSION="$(config_value dartVersion)"

if [[ "${1:-}" == "test" ]]; then
  ARGS=()
  for ARG in "$@"; do
    if [[ "$ARG" == "$PACKAGE_PATH/"* ]]; then
      ARGS+=("${ARG#"$PACKAGE_PATH/"}")
    elif [[ "$ARG" == "$PACKAGE_ROOT/"* ]]; then
      ARGS+=("${ARG#"$PACKAGE_ROOT/"}")
    else
      ARGS+=("$ARG")
    fi
  done
  cd "$PACKAGE_ROOT"
  set -- "${ARGS[@]}"
fi

if [[ -n "${BOTA_FLUTTER_HOME:-}" ]]; then
  FLUTTER="$BOTA_FLUTTER_HOME/bin/flutter"
  [[ -x "$FLUTTER" ]] || {
    printf 'BOTA_FLUTTER_HOME does not contain bin/flutter: %s\n' "$BOTA_FLUTTER_HOME" >&2
    exit 1
  }
else
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) PLATFORM="darwin-arm64" ;;
    Darwin-x86_64) PLATFORM="darwin-x64" ;;
    Linux-x86_64) PLATFORM="linux-x64" ;;
    *)
      printf 'unsupported Flutter host: %s-%s\n' "$(uname -s)" "$(uname -m)" >&2
      exit 1
      ;;
  esac

  BASE_URL="$(config_value baseUrl)"
  ARCHIVE_PATH="$(config_value "archives.$PLATFORM.path")"
  EXPECTED_SHA256="$(config_value "archives.$PLATFORM.sha256")"
  CACHE_ROOT="$ROOT/target/flutter-sdk"
  SDK_HOME="$CACHE_ROOT/$VERSION/$PLATFORM/flutter"
  ARCHIVE="$CACHE_ROOT/downloads/${ARCHIVE_PATH##*/}"
  FLUTTER="$SDK_HOME/bin/flutter"

  sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$1" | awk '{print $1}'
    else
      shasum -a 256 "$1" | awk '{print $1}'
    fi
  }

  if [[ ! -x "$FLUTTER" ]]; then
    mkdir -p "$(dirname "$ARCHIVE")" "$(dirname "$SDK_HOME")"

    if [[ -f "$ARCHIVE" && "$(sha256 "$ARCHIVE")" != "$EXPECTED_SHA256" ]]; then
      rm -f "$ARCHIVE"
    fi

    if [[ ! -f "$ARCHIVE" ]]; then
      TEMP_ARCHIVE="$ARCHIVE.download-$$"
      trap 'rm -f "${TEMP_ARCHIVE:-}"; rm -rf "${TEMP_EXTRACT:-}"' EXIT
      curl --fail --location --retry 3 --output "$TEMP_ARCHIVE" "$BASE_URL/$ARCHIVE_PATH"
      ACTUAL_SHA256="$(sha256 "$TEMP_ARCHIVE")"
      if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
        printf 'Flutter archive SHA-256 mismatch: expected %s, got %s\n' \
          "$EXPECTED_SHA256" "$ACTUAL_SHA256" >&2
        exit 1
      fi
      mv "$TEMP_ARCHIVE" "$ARCHIVE"
    fi

    ACTUAL_SHA256="$(sha256 "$ARCHIVE")"
    if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
      printf 'Flutter archive SHA-256 mismatch: expected %s, got %s\n' \
        "$EXPECTED_SHA256" "$ACTUAL_SHA256" >&2
      exit 1
    fi

    TEMP_EXTRACT="$CACHE_ROOT/.extract-$VERSION-$PLATFORM-$$"
    rm -rf "$TEMP_EXTRACT"
    mkdir -p "$TEMP_EXTRACT"
    case "$ARCHIVE" in
      *.zip) unzip -q "$ARCHIVE" -d "$TEMP_EXTRACT" ;;
      *.tar.xz) tar -xJf "$ARCHIVE" -C "$TEMP_EXTRACT" ;;
      *) printf 'unsupported Flutter archive: %s\n' "$ARCHIVE" >&2; exit 1 ;;
    esac
    rm -rf "$(dirname "$SDK_HOME")"
    mkdir -p "$(dirname "$SDK_HOME")"
    mv "$TEMP_EXTRACT/flutter" "$SDK_HOME"
    rm -rf "$TEMP_EXTRACT"
    trap - EXIT
  fi
fi

if ! TOOLCHAIN_VERSIONS="$("$FLUTTER" --version --machine | node -e '
  let source = "";
  process.stdin.on("data", (chunk) => { source += chunk; });
  process.stdin.on("end", () => {
    try {
      const metadata = JSON.parse(source);
      if (typeof metadata.frameworkVersion !== "string" || typeof metadata.dartSdkVersion !== "string") {
        process.exit(1);
      }
      process.stdout.write(metadata.frameworkVersion + "\n" + metadata.dartSdkVersion);
    } catch {
      process.exit(1);
    }
  });
')"; then
  printf 'unable to read Flutter and Dart versions from %s\n' "$FLUTTER" >&2
  exit 1
fi

ACTUAL_FLUTTER_VERSION="${TOOLCHAIN_VERSIONS%%$'\n'*}"
ACTUAL_DART_VERSION="${TOOLCHAIN_VERSIONS#*$'\n'}"
if [[ "$ACTUAL_FLUTTER_VERSION" != "$VERSION" ]]; then
  printf 'Bota Flutter toolchain requires Flutter %s, found %s\n' \
    "$VERSION" "$ACTUAL_FLUTTER_VERSION" >&2
  exit 1
fi
if [[ "$ACTUAL_DART_VERSION" != "$DART_VERSION" ]]; then
  printf 'Bota Flutter toolchain requires Dart %s, found %s\n' \
    "$DART_VERSION" "$ACTUAL_DART_VERSION" >&2
  exit 1
fi

exec "$FLUTTER" "$@"
