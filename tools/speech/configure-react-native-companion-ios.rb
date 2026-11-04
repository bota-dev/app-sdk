require 'xcodeproj'
require 'pathname'
app = File.expand_path(ARGV.fetch(0))
project = Xcodeproj::Project.open(File.join(app, 'ios/SpeechCompanion.xcodeproj'))
target = project.targets.find { |item| item.name == 'SpeechCompanion' }
group = project.main_group.find_subpath('SpeechCompanion', false)
%w[SpeechLabHost.swift SpeechLabHost.mm LabTransport.swift LabHost.swift LabOriginal.swift ReactNativeLabOwner.swift].each do |name|
  source = Pathname.new(File.join(app, 'ios/SpeechCompanion', name))
  reference = group.new_file(source.relative_path_from(group.real_path).to_s)
  abort "Missing conversation App source: #{name}" unless reference.real_path.file?
  target.source_build_phase.add_file_reference(reference)
end
package = project.new(Xcodeproj::Project::Object::XCLocalSwiftPackageReference)
package.relative_path = 'native/speech-livekit'
project.root_object.package_references << package
product = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
product.package = package
product.product_name = 'BotaSpeechLiveKit'
target.package_product_dependencies << product
framework = project.new(Xcodeproj::Project::Object::PBXBuildFile)
framework.product_ref = product
target.frameworks_build_phase.files << framework
target.build_configurations.each do |config|
  config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'dev.bota.speech.rncompanion'
end
project.save
