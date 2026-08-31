#!/usr/bin/env ruby

require_relative "../scripts/bota_device_sdk_spm_workaround"

BuildConfiguration = Struct.new(:name)

class FakePodTarget
  attr_reader :build_configurations, :name, :product_type

  def initialize(name:, product_type: "com.apple.product-type.library.static")
    @name = name
    @product_type = product_type
    @build_configurations = [BuildConfiguration.new("Debug"), BuildConfiguration.new("Release")]
    @settings = Hash.new { |hash, key| hash[key] = {} }
  end

  def build_settings(name)
    @settings[name]
  end
end

class FakeConfigFile
  attr_reader :attributes, :saved_paths

  def initialize(attributes)
    @attributes = attributes
    @saved_paths = []
  end

  def save_as(path)
    @saved_paths << path
  end
end

class FakeAggregateTarget
  attr_reader :xcconfigs

  def initialize(xcconfigs)
    @xcconfigs = xcconfigs
  end

  def xcconfig_path(name)
    "/tmp/#{name}.xcconfig"
  end
end

class FakeProject
  attr_reader :targets

  def initialize(targets)
    @targets = targets
  end
end

class FakeInstaller
  attr_reader :aggregate_targets, :pods_project

  def initialize(targets:, aggregate_targets:)
    @pods_project = FakeProject.new(targets)
    @aggregate_targets = aggregate_targets
  end
end

class FakeSPMManager
  attr_reader :base_calls

  def initialize
    @base_calls = 0
  end

  def apply_on_post_install(_installer)
    @base_calls += 1
  end
end

def assert(condition, message)
  raise message unless condition
end

def make_aggregate
  nested = "${PODS_CONFIGURATION_BUILD_DIR}/BotaDeviceSDK/BotaDeviceSDK.modulemap"
  debug = FakeConfigFile.new(
    "OTHER_CFLAGS" => "$(inherited) -fmodule-map-file=#{nested}",
    "OTHER_SWIFT_FLAGS" => "$(inherited) -Xcc -fmodule-map-file=#{nested}",
    "OTHER_LDFLAGS" => "-ObjC"
  )
  release = FakeConfigFile.new("OTHER_CFLAGS" => "$(inherited)")
  [FakeAggregateTarget.new("Debug" => debug, "Release" => release), debug, release]
end

manager = FakeSPMManager.new
BotaDeviceSDKSPMWorkaround.install!(manager)
BotaDeviceSDKSPMWorkaround.install!(manager)

bota_target = FakePodTarget.new(name: "BotaDeviceSDK")
other_target = FakePodTarget.new(name: "OtherPod")
aggregate, debug_config, release_config = make_aggregate
installer = FakeInstaller.new(
  targets: [other_target, bota_target],
  aggregate_targets: [aggregate]
)

manager.apply_on_post_install(installer)

expected_directory = "${PODS_CONFIGURATION_BUILD_DIR}"
expected_modulemap = "${PODS_CONFIGURATION_BUILD_DIR}/BotaDeviceSDK.modulemap"
assert(manager.base_calls == 1, "the original SPM post-install hook must run exactly once")
assert(
  bota_target.build_configurations.all? do |configuration|
    bota_target.build_settings(configuration.name)["CONFIGURATION_BUILD_DIR"] == expected_directory
  end,
  "the BotaDeviceSDK static target must build in the shared products directory"
)
assert(
  other_target.build_configurations.all? do |configuration|
    other_target.build_settings(configuration.name)["CONFIGURATION_BUILD_DIR"].nil?
  end,
  "unrelated pod targets must remain unchanged"
)
assert(
  debug_config.attributes.fetch("OTHER_CFLAGS").include?(expected_modulemap),
  "aggregate C flags must reference the flattened module map"
)
assert(
  debug_config.attributes.fetch("OTHER_SWIFT_FLAGS").include?(expected_modulemap),
  "aggregate Swift flags must reference the flattened module map"
)
assert(debug_config.attributes.fetch("OTHER_LDFLAGS") == "-ObjC", "unrelated flags must remain unchanged")
assert(debug_config.saved_paths == ["/tmp/Debug.xcconfig"], "changed configs must be saved once")
assert(release_config.saved_paths.empty?, "unchanged configs must not be rewritten")

dynamic_manager = FakeSPMManager.new
BotaDeviceSDKSPMWorkaround.install!(dynamic_manager)
dynamic_target = FakePodTarget.new(
  name: "BotaDeviceSDK",
  product_type: "com.apple.product-type.framework"
)
dynamic_aggregate, dynamic_debug, = make_aggregate
dynamic_installer = FakeInstaller.new(
  targets: [dynamic_target],
  aggregate_targets: [dynamic_aggregate]
)

dynamic_manager.apply_on_post_install(dynamic_installer)

assert(dynamic_manager.base_calls == 1, "the original hook must run for dynamic linkage")
assert(
  dynamic_target.build_settings("Debug")["CONFIGURATION_BUILD_DIR"].nil?,
  "dynamic framework targets must retain React Native's default layout"
)
assert(dynamic_debug.saved_paths.empty?, "dynamic linkage must not rewrite aggregate configs")

puts "BotaDeviceSDK SPM module-map workaround passed"
