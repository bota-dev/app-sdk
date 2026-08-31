require "json"
require_relative "scripts/bota_device_sdk_spm_workaround"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
apple = package.fetch("bota").fetch("apple")
version = package.fetch("version")

Pod::Spec.new do |spec|
  spec.name = apple.fetch("podName")
  spec.module_name = apple.fetch("moduleName")
  spec.version = version
  spec.summary = package.fetch("description")
  spec.homepage = "https://docs.bota.dev"
  spec.license = { type: package.fetch("license") }
  spec.author = package.fetch("author")
  spec.source = {
    git: package.fetch("repository").fetch("url"),
    tag: "v#{version}",
  }
  spec.platforms = { ios: apple.fetch("deploymentTarget") }
  spec.cocoapods_version = ">= #{apple.fetch("cocoapodsVersion")}"
  spec.swift_version = apple.fetch("swiftVersion")
  spec.source_files = "ios/**/*.{h,m,mm,swift}"
  spec.pod_target_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20",
    "DEFINES_MODULE" => "YES",
    "SWIFT_STRICT_CONCURRENCY" => "complete",
    "SWIFT_TREAT_WARNINGS_AS_ERRORS" => "YES",
  }

  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(spec)
  else
    spec.dependency "React-Core"
    spec.dependency "React-Codegen"
    spec.dependency "ReactCommon/turbomodule/core"
  end

  if respond_to?(:spm_dependency, true)
    BotaDeviceSDKSPMWorkaround.install!(SPM)
    local_path = ENV[apple.fetch("localPackagePathEnvironment")]
    source = local_path.nil? || local_path.empty? ? apple.fetch("packageUrl") : File.expand_path(local_path)
    requirement = local_path.nil? || local_path.empty? ? {
      kind: apple.fetch("packageRequirement"),
      version: version,
    } : {}

    spm_dependency(
      spec,
      url: source,
      requirement: requirement,
      products: [apple.fetch("packageProduct")],
    )
  end
end
