#!/usr/bin/env bash
# Build an unpublished, binary-only iOS SDK. Does not change the source Pod or Swift package.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
core="$root/platforms/apple/Artifacts/BotaDeviceSDKCore.xcframework"
out="$root/target/apple-static-ios"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out" "$tmp/sdk/Sources" "$tmp/consumer"
if [[ ! -f "$core/Info.plist" ]]; then
  "$root/tools/apple/build-xcframework.sh"
fi

# Keep the Clang module private to the binary build; the consumer must not need its module map.
cp -R "$root/platforms/apple/Sources/BotaAppSDK/." "$tmp/sdk/Sources/"
find "$tmp/sdk/Sources" -name '*.swift' -exec perl -pi -e 's/^import BotaDeviceSDKC[ \t]*$/\@_implementationOnly import BotaDeviceSDKC/' {} +

cat > "$tmp/project.rb" <<'RUBY'
require 'xcodeproj'
Dir.chdir(ARGV.fetch(0))
consumer = ARGV.fetch(1) == 'consumer'
name = consumer ? 'BinaryConsumer' : 'BotaAppSDK'
project = Xcodeproj::Project.new("#{name}.xcodeproj")
target = project.new_target(consumer ? :application : :framework, name, :ios, '15.0')
target.build_configurations.each do |configuration|
  s = configuration.build_settings
  s.merge!({
    'PRODUCT_NAME' => name,
    'PRODUCT_BUNDLE_IDENTIFIER' => "dev.bota.#{name}",
    'SWIFT_VERSION' => '6.0',
    'IPHONEOS_DEPLOYMENT_TARGET' => '15.0',
    'SUPPORTED_PLATFORMS' => 'iphoneos iphonesimulator',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'CODE_SIGNING_ALLOWED' => 'NO'
  })
  unless consumer
    s.merge!({
      'DEFINES_MODULE' => 'YES',
      'MACH_O_TYPE' => 'staticlib',
      'BUILD_LIBRARY_FOR_DISTRIBUTION' => 'YES',
      'SKIP_INSTALL' => 'NO',
      'SWIFT_INCLUDE_PATHS' => ['$(inherited)', ARGV.fetch(2)],
      'SWIFT_STRICT_CONCURRENCY' => 'complete'
    })
  end
end
if consumer
  target.add_file_references([project.main_group.new_file('main.swift')])
  ref = project.main_group.new_file('BotaAppSDK.xcframework')
  ref.last_known_file_type = 'wrapper.xcframework'
  target.frameworks_build_phase.add_file_reference(ref)
else
  target.add_file_references(Dir['Sources/**/*.swift'].sort.map { |p| project.main_group.new_file(p) })
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target)
scheme.set_launch_target(target) if consumer
scheme.save_as(project.path, name, true)
RUBY

ruby "$tmp/project.rb" "$tmp/sdk" sdk "$root/bindings/device-sdk-ffi/include"
build() {
  local project="$1" scheme="$2" sdk="$3" archs="$4" output="$5" destination
  if [[ "$sdk" == iphoneos ]]; then destination="generic/platform=iOS"; else destination="generic/platform=iOS Simulator"; fi
  xcodebuild -project "$project/$scheme.xcodeproj" -scheme "$scheme" \
    -configuration Release -sdk "$sdk" -destination "$destination" -derivedDataPath "$output" \
    "ARCHS=$archs" ONLY_ACTIVE_ARCH=NO EXCLUDED_ARCHS= \
    CODE_SIGNING_ALLOWED=NO build
}
for sdk in iphoneos iphonesimulator; do
  if [[ "$sdk" == iphoneos ]]; then
    archs=arm64
    library="$core/ios-arm64/libbota_device_sdk_ffi.a"
  else
    archs='arm64 x86_64'
    library="$core/ios-arm64_x86_64-simulator/libbota_device_sdk_ffi.a"
  fi
  build "$tmp/sdk" BotaAppSDK "$sdk" "$archs" "$tmp/build-$sdk"
  framework="$tmp/build-$sdk/Build/Products/Release-$sdk/BotaAppSDK.framework"
  bin="$framework/BotaAppSDK"
  xcrun lipo "$bin" -verify_arch $archs
  for arch in $archs; do
    if [[ "$sdk" == iphoneos ]]; then
      swift_archive="$bin"
      rust_archive="$library"
    else
      swift_archive="$tmp/swift-$sdk-$arch.a"
      rust_archive="$tmp/rust-$sdk-$arch.a"
      xcrun lipo "$bin" -thin "$arch" -output "$swift_archive"
      xcrun lipo "$library" -thin "$arch" -output "$rust_archive"
    fi
    xcrun libtool -static -o "$tmp/combined-$sdk-$arch.a" "$swift_archive" "$rust_archive"
    if [[ "$sdk" == iphoneos ]]; then triple="$arch-apple-ios"; else triple="$arch-apple-ios-simulator"; fi
    interface="$framework/Modules/BotaAppSDK.swiftmodule/$triple.swiftinterface"
    test -s "$interface"
    if grep -q 'BotaDeviceSDKC' "$interface"; then
      echo "Private FFI dependency leaked into $interface" >&2
      exit 1
    fi
  done
  if [[ "$sdk" == iphoneos ]]; then
    mv "$tmp/combined-$sdk-arm64.a" "$bin"
  else
    xcrun lipo -create "$tmp/combined-$sdk-arm64.a" "$tmp/combined-$sdk-x86_64.a" -output "$tmp/combined-simulator.a"
    mv "$tmp/combined-simulator.a" "$bin"
  fi
done

xcodebuild -create-xcframework \
  -framework "$tmp/build-iphoneos/Build/Products/Release-iphoneos/BotaAppSDK.framework" \
  -framework "$tmp/build-iphonesimulator/Build/Products/Release-iphonesimulator/BotaAppSDK.framework" \
  -output "$tmp/BotaAppSDK.xcframework"

# Keep the clean test consumer separate from the SDK source tree and C module.
# Also force the consumer to import from the shipped public textual interfaces.
cp -R "$tmp/BotaAppSDK.xcframework" "$tmp/consumer/"
find "$tmp/consumer/BotaAppSDK.xcframework" -type f -name '*.swiftmodule' -delete
find "$tmp/consumer/BotaAppSDK.xcframework" -type f -name '*.private.swiftinterface' -delete
cat > "$tmp/consumer/main.swift" <<'SWIFT'
import UIKit
import BotaAppSDK

final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let client = BotaDeviceClient()
        Task {
            try? await client.configure()
            await client.destroy()
        }
        return true
    }
}
UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
SWIFT
ruby "$tmp/project.rb" "$tmp/consumer" consumer
for pair in iphoneos:arm64 iphonesimulator:arm64 iphonesimulator:x86_64; do
  sdk="$(cut -d: -f1 <<< "$pair")"
  arch="$(cut -d: -f2 <<< "$pair")"
  build "$tmp/consumer" BinaryConsumer "$sdk" "$arch" "$tmp/consumer-$sdk-$arch"
  app="$tmp/consumer-$sdk-$arch/Build/Products/Release-$sdk/BinaryConsumer.app/BinaryConsumer"
  xcrun lipo "$app" -verify_arch "$arch"
  xcrun otool -L "$app" > "$tmp/deps.txt"
  if grep -E 'BotaAppSDK|BotaDeviceSDKCore' "$tmp/deps.txt"; then
    echo 'Consumer depends on a dynamic Bota binary' >&2
    exit 1
  fi
done

archive="$out/BotaAppSDK.xcframework.zip"
rm -f "$archive"
ditto -c -k --keepParent "$tmp/BotaAppSDK.xcframework" "$archive"
(cd "$out" && shasum -a 256 BotaAppSDK.xcframework.zip > BotaAppSDK.xcframework.zip.sha256)
