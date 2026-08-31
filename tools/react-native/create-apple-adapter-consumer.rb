#!/usr/bin/env ruby

require "fileutils"
require "json"
require "pathname"
require "xcodeproj"

output_dir = Pathname.new(ARGV.fetch(0)).expand_path
workspace_root = Pathname.new(ARGV.fetch(1)).expand_path
package_root = Pathname.new(ARGV.fetch(2)).expand_path
react_native_path = package_root.join("node_modules/react-native")

FileUtils.mkdir_p(output_dir)
FileUtils.mkdir_p(output_dir.join("node_modules/@bota.dev"))
FileUtils.ln_sf(package_root, output_dir.join("node_modules/@bota.dev/react-native-sdk"))
FileUtils.ln_sf(react_native_path, output_dir.join("node_modules/react-native"))
FileUtils.ln_sf(package_root.join("node_modules/react"), output_dir.join("node_modules/react"))

package_json = {
  "name" => "bota-apple-adapter-consumer",
  "version" => "1.0.0",
  "private" => true,
  "dependencies" => {
    "@bota.dev/react-native-sdk" => "file:#{package_root}",
    "react" => "19.2.3",
    "react-native" => "0.86.3",
  },
}
File.write(output_dir.join("package.json"), "#{JSON.pretty_generate(package_json)}\n")

source = <<~OBJC
  #import <UIKit/UIKit.h>

  @interface AppDelegate : UIResponder <UIApplicationDelegate>
  @property(nonatomic, strong) UIWindow *window;
  @end

  @implementation AppDelegate
  - (BOOL)application:(UIApplication *)application
      didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
  {
    return YES;
  }
  @end

  int main(int argc, char *argv[])
  {
    @autoreleasepool {
      return UIApplicationMain(argc, argv, nil, NSStringFromClass([AppDelegate class]));
    }
  }
OBJC
File.write(output_dir.join("main.m"), source)

plist = <<~PLIST
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
    <key>CFBundleExecutable</key>
    <string>$(EXECUTABLE_NAME)</string>
    <key>CFBundleIdentifier</key>
    <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
    <key>CFBundleName</key>
    <string>AdapterConsumer</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>NSBluetoothAlwaysUsageDescription</key>
    <string>Verify the Bota SDK Bluetooth adapter.</string>
  </dict>
  </plist>
PLIST
File.write(output_dir.join("Info.plist"), plist)

project = Xcodeproj::Project.new(output_dir.join("AdapterConsumer.xcodeproj"))
target = project.new_target(:application, "AdapterConsumer", :ios, "15.1")
source_ref = project.main_group.new_file("main.m")
target.source_build_phase.add_file_reference(source_ref)
target.build_configurations.each do |configuration|
  configuration.build_settings["CODE_SIGNING_ALLOWED"] = "NO"
  configuration.build_settings["GENERATE_INFOPLIST_FILE"] = "NO"
  configuration.build_settings["INFOPLIST_FILE"] = "Info.plist"
  configuration.build_settings["PRODUCT_BUNDLE_IDENTIFIER"] = "dev.bota.adapter-consumer"
  configuration.build_settings["SWIFT_VERSION"] = "6.0"
end
project.save

podfile = <<~RUBY
  ENV["BOTA_APPLE_SDK_PACKAGE_PATH"] = #{workspace_root.to_s.inspect}
  ENV["RCT_USE_RN_DEP"] = "1"
  ENV["RCT_USE_PREBUILT_RNCORE"] = "1"

  require #{react_native_path.join("scripts/react_native_pods").to_s.inspect}

  platform :ios, "15.1"
  prepare_react_native_project!

  target "AdapterConsumer" do
    use_react_native!(
      path: #{react_native_path.to_s.inspect},
      app_path: #{output_dir.to_s.inspect},
      privacy_file_aggregation_enabled: false
    )
    pod "BotaDeviceSDK", path: #{package_root.to_s.inspect}
  end

  post_install do |installer|
    react_native_post_install(
      installer,
      #{react_native_path.to_s.inspect},
      mac_catalyst_enabled: false
    )
  end
RUBY
File.write(output_dir.join("Podfile"), podfile)
