require 'xcodeproj'
app = File.expand_path(ARGV.fetch(0))
project = Xcodeproj::Project.open(File.join(app, 'ios/SpeechCompanion.xcodeproj'))
target = project.targets.find { |item| item.name == 'SpeechCompanion' }
group = project.main_group.find_subpath('SpeechCompanion', false)
%w[SpeechLabHost.swift SpeechLabHost.mm LabTransport.swift].each do |name|
  reference = group.new_file(name)
  target.source_build_phase.add_file_reference(reference)
end
target.build_configurations.each do |config|
  config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'dev.bota.speech.rncompanion'
end
project.save
