Pod::Spec.new do |spec|
  spec.name = "BotaAppleSDK"
  spec.module_name = "BotaAppleSDK"
  spec.version = "1.2.0-beta.10"
  spec.summary = "Bota App SDK for Apple platforms"
  spec.homepage = "https://docs.bota.dev"
  spec.license = { type: "Apache-2.0" }
  spec.author = "Bota"
  spec.source = {
    http: "https://github.com/bota-dev/app-sdk/releases/download/v1.2.0-beta.10/BotaAppleSDK.cocoapods.zip",
    sha256: "39f0925c51ee515ba915bebae165ec56fedbca688441e12cd33d13b44ffbb72d",
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
end
