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
  spec.swift_version = "6.0"
  spec.source_files = "Classes/**/*.swift"
  spec.dependency "Flutter"
  spec.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
    "SWIFT_STRICT_CONCURRENCY" => "complete",
    "SWIFT_TREAT_WARNINGS_AS_ERRORS" => "YES",
  }

  if respond_to?(:spm_dependency, true)
    local_path = ENV["BOTA_APPLE_SDK_PACKAGE_PATH"]
    source = local_path.nil? || local_path.empty? \
      ? "https://github.com/bota-dev/app-sdk.git" \
      : File.expand_path(local_path)
    requirement = local_path.nil? || local_path.empty? \
      ? { kind: "exactVersion", version: version } \
      : {}

    spm_dependency(
      spec,
      url: source,
      requirement: requirement,
      products: ["BotaAppleSDK"],
    )
  end
end
