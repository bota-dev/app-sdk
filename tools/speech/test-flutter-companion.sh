#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mode="${1:---android}"
case "$mode" in --dart-only|--android|--ios|--all) ;; *) echo 'Usage: test-flutter-companion.sh [--dart-only|--android|--ios|--all]' >&2; exit 1 ;; esac
"$root/tools/flutter/run-flutter.sh" --version >/dev/null
version="$(node -p "require('$root/tools/flutter/flutter-version.json').version")"
case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) platform=darwin-arm64 ;; Darwin-x86_64) platform=darwin-x64 ;; Linux-x86_64) platform=linux-x64 ;;
    *) echo 'Unsupported Flutter host' >&2; exit 1 ;;
esac
flutter="${BOTA_FLUTTER_HOME:-$root/target/flutter-sdk/$version/$platform/flutter}/bin/flutter"
source="$root/tests/consumers/flutter-speech"
(cd "$source"; "$flutter" pub get --enforce-lockfile; "$flutter" analyze; "$flutter" test)
[[ "$mode" == --dart-only ]] && exit 0
if ! command -v rustc >/dev/null 2>&1 && [[ -x /opt/homebrew/opt/rustup/bin/rustc ]]; then export PATH="/opt/homebrew/opt/rustup/bin:$PATH"; fi
if [[ -z "${JAVA_HOME:-}" && -d /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ]]; then export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home; fi
if [[ -z "${ANDROID_HOME:-}" && -d /opt/homebrew/share/android-commandlinetools/platforms ]]; then export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools; fi
app="$(mktemp -d "${TMPDIR:-/tmp}/bota-flutter-speech.XXXXXX")/app"
"$flutter" create --no-pub --platforms=ios,android --org=dev.bota --project-name=bota_speech_companion "$app" </dev/null >/dev/null
python3 "$root/tools/speech/prepare-flutter-companion.py" "$root" "$app"
# This disposable host remains available for inspecting failed build output.
printf 'Flutter speech consumer: %s\n' "$app"
output="$root/target/flutter-speech-companion"
mkdir -p "$output"
if [[ "$mode" == --android || "$mode" == --all ]]; then
    "$root/platforms/android/gradlew" -p "$root/platforms/android" :sdk:publishMavenPublicationToLocalRepository :speech-livekit:assembleRelease
    (cd "$app"; "$flutter" pub get --enforce-lockfile; "$flutter" build apk --debug)
    cp "$app/build/app/outputs/flutter-apk/app-debug.apk" "$output/flutter-speech-companion-debug.apk"
fi
if [[ "$mode" == --ios || "$mode" == --all ]]; then
    "$root/tools/apple/build-xcframework.sh"
    ruby_binary="$(command -v ruby)"
    if [[ -x /opt/homebrew/opt/ruby/bin/ruby ]]; then ruby_binary=/opt/homebrew/opt/ruby/bin/ruby; fi
    "$ruby_binary" "$root/tools/speech/configure-flutter-companion-ios.rb" "$app"
    (cd "$app"; "$flutter" pub get --enforce-lockfile; "$flutter" build ios --debug --no-codesign)
    ditto -c -k --keepParent "$app/build/ios/iphoneos/Runner.app" "$output/flutter-speech-companion-ios.zip"
fi
