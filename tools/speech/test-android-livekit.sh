#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if ! command -v rustc >/dev/null 2>&1 && [[ -x "$HOME/.cargo/bin/rustc" ]]; then
    export PATH="$HOME/.cargo/bin:$PATH"
fi
if ! command -v rustc >/dev/null 2>&1 && [[ -x /opt/homebrew/opt/rustup/bin/rustc ]]; then
    export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
fi
if [[ -z "${JAVA_HOME:-}" && -d /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ]]; then
    export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
fi
if [[ -z "${ANDROID_HOME:-}" && -d /opt/homebrew/share/android-commandlinetools/platforms ]]; then
    export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
fi
exec "$ROOT/platforms/android/gradlew" -p "$ROOT/platforms/android" \
    :speech-livekit:testDebugUnitTest :speech-livekit:lintRelease :speech-livekit:assembleRelease "$@"
