Pod::Spec.new do |spec|
  spec.name = "BotaAppleSDK"
  spec.module_name = "BotaAppleSDK"
  spec.version = "1.2.0-beta.7"
  spec.summary = "Bota App SDK for Apple platforms"
  spec.homepage = "https://docs.bota.dev"
  spec.license = { type: "Apache-2.0" }
  spec.author = "Bota"
  spec.source = {
    git: "https://github.com/bota-dev/app-sdk.git",
    tag: "v#{spec.version}",
  }
  spec.platforms = { ios: "15.0", osx: "13.0" }
  spec.cocoapods_version = ">= 1.13"
  spec.swift_version = "6.0"
  spec.source_files = "{,platforms/apple/}Sources/BotaAppleSDK/**/*.swift"
  spec.vendored_frameworks =
    "{,platforms/apple/}Artifacts/BotaDeviceSDKCore.xcframework"
  spec.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
    "SWIFT_STRICT_CONCURRENCY" => "complete",
    "SWIFT_TREAT_WARNINGS_AS_ERRORS" => "YES",
  }
  spec.prepare_command = <<-CMD
    set -eu
    package_root="."
    if [ -d "platforms/apple" ]; then package_root="platforms/apple"; fi
    artifact="$package_root/Artifacts/BotaDeviceSDKCore.xcframework"
    if [ ! -d "$artifact" ]; then
      mkdir -p "$package_root/Artifacts"
      archive="$package_root/Artifacts/BotaDeviceSDKCore.xcframework.zip"
      checksum="$archive.sha256"
      base="https://github.com/bota-dev/app-sdk/releases/download/v#{spec.version}"
      curl --fail --location --retry 3 --output "$archive" \
        "$base/BotaDeviceSDKCore.xcframework.zip"
      curl --fail --location --retry 3 --output "$checksum" \
        "$base/BotaDeviceSDKCore.xcframework.zip.sha256"
      (cd "$package_root/Artifacts" && shasum -a 256 -c "$(basename "$checksum")")
      unzip -q "$archive" -d "$package_root/Artifacts"
      rm -f "$archive" "$checksum"
    fi
  CMD
end
