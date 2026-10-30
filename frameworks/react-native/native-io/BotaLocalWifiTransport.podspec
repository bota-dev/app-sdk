require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |spec|
  spec.name = "BotaLocalWifiTransport"
  spec.version = package.fetch("version")
  spec.summary = "Local WiFi association and pinned TLS OS primitives for the JavaScript runtime"
  spec.homepage = "https://docs.bota.dev"
  spec.license = { type: package.fetch("license") }
  spec.author = package.fetch("author")
  spec.source = { git: package.fetch("repository").fetch("url"), tag: "v#{spec.version}" }
  spec.platforms = { ios: "15.1" }
  spec.swift_version = "6.0"
  spec.source_files = "generated/apple/*.{mm,swift}"
  spec.frameworks = "Network", "NetworkExtension", "Security", "CryptoKit"
  spec.pod_target_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20",
    "DEFINES_MODULE" => "YES",
    "SWIFT_STRICT_CONCURRENCY" => "complete",
    "SWIFT_TREAT_WARNINGS_AS_ERRORS" => "YES",
    "SWIFT_ACTIVE_COMPILATION_CONDITIONS" => "$(inherited) BOTA_LOCAL_WIFI_STANDALONE",
  }
  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(spec)
  else
    spec.dependency "React-Core"
    spec.dependency "React-Codegen"
    spec.dependency "ReactCommon/turbomodule/core"
  end
end
