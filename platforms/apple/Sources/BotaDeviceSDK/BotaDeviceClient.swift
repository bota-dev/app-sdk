public final class BotaDeviceClient: @unchecked Sendable {
    public static let shared = BotaDeviceClient()

    public let devices: DeviceManager
    public let provisioning: ProvisioningManager
    public let factoryReset: FactoryResetManager
    private let lifecycle = BotaClientLifecycle()

    public init() {
        devices = DeviceManager()
        provisioning = ProvisioningManager()
        factoryReset = FactoryResetManager()
    }

    public func configure(_ configuration: BotaConfiguration = .init()) async throws {
        try await lifecycle.configure(
            configuration,
            devices: devices,
            provisioning: provisioning,
            factoryReset: factoryReset
        )
    }

    public func destroy() async {
        await lifecycle.destroy(
            devices: devices,
            provisioning: provisioning,
            factoryReset: factoryReset
        )
    }
}

private actor BotaClientLifecycle {
    private var runtime: DeviceRuntime?

    func configure(
        _ configuration: BotaConfiguration,
        devices: DeviceManager,
        provisioning: ProvisioningManager,
        factoryReset: FactoryResetManager
    ) async throws {
        guard runtime == nil else { return }
        let runtime = try await configuration.runtimeFactory()
        self.runtime = runtime
        await devices.attach(runtime)
        await provisioning.attach(runtime)
        await factoryReset.attach(runtime)
    }

    func destroy(
        devices: DeviceManager,
        provisioning: ProvisioningManager,
        factoryReset: FactoryResetManager
    ) async {
        guard runtime != nil else { return }
        await provisioning.detach()
        await factoryReset.detach()
        await devices.detach()
        runtime = nil
    }
}
