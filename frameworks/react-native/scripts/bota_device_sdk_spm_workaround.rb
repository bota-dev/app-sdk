module BotaDeviceSDKSPMWorkaround
  POD_NAME = "BotaDeviceSDK"
  STATIC_LIBRARY_PRODUCT_TYPE = "com.apple.product-type.library.static"
  SHARED_PRODUCTS_DIRECTORY = "${PODS_CONFIGURATION_BUILD_DIR}"

  module PostInstallPatch
    def apply_on_post_install(installer)
      super
      BotaDeviceSDKSPMWorkaround.apply(installer)
    end
  end

  def self.install!(manager)
    singleton = manager.singleton_class
    singleton.prepend(PostInstallPatch) unless singleton.ancestors.include?(PostInstallPatch)
  end

  def self.apply(installer)
    target = installer.pods_project.targets.find { |candidate| candidate.name == POD_NAME }
    return unless target&.product_type == STATIC_LIBRARY_PRODUCT_TYPE

    target.build_configurations.each do |configuration|
      target.build_settings(configuration.name)["CONFIGURATION_BUILD_DIR"] =
        SHARED_PRODUCTS_DIRECTORY
    end

    rewrite_aggregate_modulemap_references(installer)
  end

  def self.rewrite_aggregate_modulemap_references(installer)
    nested = "${PODS_CONFIGURATION_BUILD_DIR}/#{POD_NAME}/#{POD_NAME}.modulemap"
    flattened = "${PODS_CONFIGURATION_BUILD_DIR}/#{POD_NAME}.modulemap"

    installer.aggregate_targets.each do |aggregate_target|
      aggregate_target.xcconfigs.each do |configuration_name, config_file|
        changed = false
        %w[OTHER_CFLAGS OTHER_SWIFT_FLAGS].each do |key|
          value = config_file.attributes[key]
          next unless value

          updated = value.gsub(nested, flattened)
          next if updated == value

          config_file.attributes[key] = updated
          changed = true
        end
        config_file.save_as(aggregate_target.xcconfig_path(configuration_name)) if changed
      end
    end
  end

  private_class_method :rewrite_aggregate_modulemap_references
end
