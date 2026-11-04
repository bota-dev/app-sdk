require "xcodeproj"
require "pathname"

app = Pathname.new(ARGV.fetch(0)).expand_path
project = Xcodeproj::Project.open(app.join("ios/Runner.xcodeproj"))
runner = project.targets.find { |target| target.name == "Runner" }
group = project.main_group.find_subpath("Runner", false)
%w[LabHost.swift LabTransport.swift FlutterLabOwner.swift].each do |name|
  runner.source_build_phase.add_file_reference(group.new_file(name))
end
package = project.new(Xcodeproj::Project::Object::XCLocalSwiftPackageReference)
package.relative_path = "../native/speech-livekit"
project.root_object.package_references << package
product = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
product.package = package
product.product_name = "BotaSpeechLiveKit"
runner.package_product_dependencies << product
framework = project.new(Xcodeproj::Project::Object::PBXBuildFile)
framework.product_ref = product
runner.frameworks_build_phase.files << framework
project.build_configurations.each { |config| config.build_settings["IPHONEOS_DEPLOYMENT_TARGET"] = "15.0" }
runner.build_configurations.each do |config|
  config.build_settings["IPHONEOS_DEPLOYMENT_TARGET"] = "15.0"
  config.build_settings["PRODUCT_BUNDLE_IDENTIFIER"] = "dev.bota.speech.fluttercompanion"
end
project.save
