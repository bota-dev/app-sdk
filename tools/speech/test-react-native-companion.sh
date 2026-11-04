#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mode="${1:---android}"
case "$mode" in
    "--js-only" | "--android" | "--ios") ;;
    *) echo 'Usage: test-react-native-companion.sh [--js-only|--android|--ios]' >&2; exit 1 ;;
esac
app="$root/tests/consumers/react-native-speech"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"
(cd "$root/frameworks/react-native"; npm run build)
(cd "$app"; npm ci --ignore-scripts; npm run check; npm test; node "$root/scripts/check-licenses.mjs")
[[ "$mode" == --js-only ]] && exit 0
python3 "$root/tools/speech/prepare-react-native-companion.py" "$root"
output="$root/target/react-native-speech-companion"
mkdir -p "$output"
if [[ "$mode" == --android ]]; then
    if [[ -z "${JAVA_HOME:-}" && -d /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ]]; then export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home; fi
    if [[ -z "${ANDROID_HOME:-}" && -d /opt/homebrew/share/android-commandlinetools/platforms ]]; then export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools; fi
    "$root/platforms/android/gradlew" -p "$root/platforms/android" :sdk:publishMavenPublicationToLocalRepository :speech-livekit:assembleRelease
    # Internal APK: bundled JS/Hermes, no Metro or development reload, disposable test key.
    "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$app/android/app/speech-debug.keystore" -storepass android -alias androiddebugkey -keypass android \
        -dname 'CN=Internal Speech Companion' -keyalg RSA -validity 30
    "$app/android/gradlew" -p "$app/android" :app:assembleRelease :app:lintRelease --max-workers=2 -PreactNativeArchitectures=arm64-v8a,x86_64
    python3 "$root/tools/speech/check-react-native-companion-android.py" "$app/android/app"
    cp "$app/android/app/build/outputs/apk/release/app-release.apk" "$output/react-native-speech-companion.apk"
else
    "$root/tools/apple/build-xcframework.sh"
    if [[ -n "${BUNDLE_GEMFILE:-}" ]]; then
        bundle exec ruby "$root/tools/speech/configure-react-native-companion-ios.rb" "$app"
        (cd "$app/ios"; bundle exec pod install)
    else
        ruby "$root/tools/speech/configure-react-native-companion-ios.rb" "$app"
        (cd "$app/ios"; pod install)
    fi
    xcodebuild -quiet -workspace "$app/ios/SpeechCompanion.xcworkspace" -scheme SpeechCompanion \
        -configuration Release -destination 'generic/platform=iOS' -derivedDataPath "$app/target/ios-build" CODE_SIGNING_ALLOWED=NO build
    ditto -c -k --keepParent "$app/target/ios-build/Build/Products/Release-iphoneos/SpeechCompanion.app" "$output/react-native-speech-companion-ios.zip"
fi
