require "yaml"

package = YAML.safe_load(File.read(File.join(__dir__, "..", "pubspec.yaml")))
version = package.fetch("version")

Pod::Spec.new do |spec|
  spec.name = "bota_flutter_sdk"
  spec.module_name = "bota_flutter_sdk"
  spec.version = version
  spec.summary = "Bota App SDK Flutter facade"
  spec.homepage = "https://docs.bota.dev"
  spec.license = { type: "Apache-2.0" }
  spec.author = "Bota"
  spec.source = {
    git: "https://github.com/bota-dev/app-sdk.git",
    tag: "v#{version}",
  }
  spec.platform = :ios, "15.0"
  spec.cocoapods_version = ">= 1.13"
  spec.swift_version = "5.0"
  spec.source_files = "bota_flutter_sdk/Sources/bota_flutter_sdk/**/*.swift"
  spec.dependency "Flutter"
  spec.dependency "BotaAppleSDK", version
  spec.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
    "SWIFT_STRICT_CONCURRENCY" => "complete",
  }
end
