public final class BotaDeviceClient: @unchecked Sendable {
    public static let shared = BotaDeviceClient()

    public let devices: DeviceManager
    private let lifecycle = BotaClientLifecycle()

    public init() {
        devices = DeviceManager()
    }

    public func configure(_ configuration: BotaConfiguration = .init()) async throws {
        try await lifecycle.configure(configuration, devices: devices)
    }

    public func destroy() async {
        await lifecycle.destroy(devices: devices)
    }
}

private actor BotaClientLifecycle {
    private var runtime: DeviceRuntime?

    func configure(_ configuration: BotaConfiguration, devices: DeviceManager) async throws {
        guard runtime == nil else { return }
        let runtime = try await configuration.runtimeFactory()
        self.runtime = runtime
        await devices.attach(runtime)
    }

    func destroy(devices: DeviceManager) async {
        guard runtime != nil else { return }
        await devices.detach()
        runtime = nil
    }
}
