Pod::Spec.new do |spec|
  spec.name = "BotaAppSDK"
  spec.module_name = "BotaAppSDK"
  spec.version = "2.0.0-beta.9"
  spec.summary = "Bota App SDK for Apple platforms"
  spec.homepage = "https://docs.bota.dev"
  spec.license = { type: "Apache-2.0" }
  spec.author = "Bota"
  spec.source = {
    http: "https://github.com/bota-dev/app-sdk/releases/download/v2.0.0-beta.9/BotaAppSDK.cocoapods.zip",
    sha256: "6cdf824e28e732ce67f4db6cd4b8e0afc64dd9de141cd9aa3bcb8ec1aea44477",
  }
  spec.platforms = { ios: "15.0", osx: "13.0" }
  spec.cocoapods_version = ">= 1.13"
  spec.swift_version = "6.0"
  spec.source_files = "{,platforms/apple/}Sources/BotaAppSDK/**/*.swift"
  spec.vendored_frameworks =
    "{,platforms/apple/}Artifacts/BotaDeviceSDKCore.xcframework"
  spec.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
    "SWIFT_STRICT_CONCURRENCY" => "complete",
    "SWIFT_TREAT_WARNINGS_AS_ERRORS" => "YES",
  }
end
