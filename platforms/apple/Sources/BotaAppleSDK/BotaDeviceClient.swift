public final class BotaDeviceClient: @unchecked Sendable {
    public static let shared = BotaDeviceClient()

    public let devices: DeviceManager
    public let wifi: WiFiManager
    public let provisioning: ProvisioningManager
    public let factoryReset: FactoryResetManager
    public let recordings: RecordingManager
    public let ota: OTAManager
    public let logs: DeviceLogManager
    private let lifecycle = BotaClientLifecycle()

    public init() {
        devices = DeviceManager()
        wifi = WiFiManager()
        provisioning = ProvisioningManager()
        factoryReset = FactoryResetManager()
        recordings = RecordingManager()
        ota = OTAManager()
        logs = DeviceLogManager()
    }

    public func configure(_ configuration: BotaConfiguration = .init()) async throws {
        try await lifecycle.configure(
            configuration,
            devices: devices,
            wifi: wifi,
            provisioning: provisioning,
            factoryReset: factoryReset,
            recordings: recordings,
            ota: ota,
            logs: logs
        )
    }

    public func destroy() async {
        await lifecycle.destroy(
            devices: devices,
            wifi: wifi,
            provisioning: provisioning,
            factoryReset: factoryReset,
            recordings: recordings,
            ota: ota,
            logs: logs
        )
    }
}

private actor BotaClientLifecycle {
    private var runtime: DeviceRuntime?

    func configure(
        _ configuration: BotaConfiguration,
        devices: DeviceManager,
        wifi: WiFiManager,
        provisioning: ProvisioningManager,
        factoryReset: FactoryResetManager,
        recordings: RecordingManager,
        ota: OTAManager,
        logs: DeviceLogManager
    ) async throws {
        guard runtime == nil else { return }
        let runtime = try await configuration.runtimeFactory()
        self.runtime = runtime
        await devices.attach(runtime)
        await wifi.attach(runtime)
        await provisioning.attach(runtime)
        await factoryReset.attach(runtime)
        await recordings.attach(runtime)
        await ota.attach(runtime)
        await logs.attach(runtime)
    }

    func destroy(
        devices: DeviceManager,
        wifi: WiFiManager,
        provisioning: ProvisioningManager,
        factoryReset: FactoryResetManager,
        recordings: RecordingManager,
        ota: OTAManager,
        logs: DeviceLogManager
    ) async {
        guard runtime != nil else { return }
        await logs.detach()
        await ota.detach()
        await recordings.detach()
        await wifi.detach()
        await provisioning.detach()
        await factoryReset.detach()
        await devices.detach()
        runtime = nil
    }
}
