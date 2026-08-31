import BotaAppleSDK
import Foundation

protocol BotaDeviceSDKAppleWiFiClient: Sendable {
    func configure(
        _ device: ConnectedDevice,
        ssid: String,
        password: String,
        grantBlob: String
    ) async throws -> WiFiConfigResult
    func disconnect(_ device: ConnectedDevice) async throws -> WiFiConfigResult
    func readStatus(_ device: ConnectedDevice) async throws -> WiFiStatusInfo
    func statusUpdates(
        _ device: ConnectedDevice
    ) async throws -> AsyncThrowingStream<WiFiStatusInfo, Error>
    func scanNetworks(_ device: ConnectedDevice) async throws -> DeviceWiFiScanResult
    func cancelCurrentOperation() async
}

struct BotaDeviceSDKSharedAppleWiFiClient: BotaDeviceSDKAppleWiFiClient {
    private let wifi: WiFiManager

    init(client: BotaDeviceClient = .shared) {
        wifi = client.wifi
    }

    func configure(
        _ device: ConnectedDevice,
        ssid: String,
        password: String,
        grantBlob: String
    ) async throws -> WiFiConfigResult {
        try await wifi.configure(
            device,
            ssid: ssid,
            password: password,
            grantBlob: grantBlob
        )
    }

    func disconnect(_ device: ConnectedDevice) async throws -> WiFiConfigResult {
        try await wifi.disconnect(device)
    }

    func readStatus(_ device: ConnectedDevice) async throws -> WiFiStatusInfo {
        try await wifi.readStatus(device)
    }

    func statusUpdates(
        _ device: ConnectedDevice
    ) async throws -> AsyncThrowingStream<WiFiStatusInfo, Error> {
        try await wifi.statusUpdates(device)
    }

    func scanNetworks(_ device: ConnectedDevice) async throws -> DeviceWiFiScanResult {
        try await wifi.scanNetworks(device)
    }

    func cancelCurrentOperation() async {
        await wifi.cancelCurrentOperation()
    }
}

actor BotaDeviceSDKAppleWiFi {
    private let client: any BotaDeviceSDKAppleWiFiClient
    private var statusTask: Task<Void, Never>?

    init(client: any BotaDeviceSDKAppleWiFiClient = BotaDeviceSDKSharedAppleWiFiClient()) {
        self.client = client
    }

    func configure(
        _ device: ConnectedDevice,
        ssid: String,
        password: String,
        grantBlob: String
    ) async throws -> WiFiConfigResult {
        try await client.configure(
            device,
            ssid: ssid,
            password: password,
            grantBlob: grantBlob
        )
    }

    func disconnect(_ device: ConnectedDevice) async throws -> WiFiConfigResult {
        try await client.disconnect(device)
    }

    func readStatus(_ device: ConnectedDevice) async throws -> WiFiStatusInfo {
        try await client.readStatus(device)
    }

    func scanNetworks(_ device: ConnectedDevice) async throws -> DeviceWiFiScanResult {
        try await client.scanNetworks(device)
    }

    func startStatusUpdates(
        _ device: ConnectedDevice,
        onStatus: @escaping @Sendable (WiFiStatusInfo) -> Void,
        onError: @escaping @Sendable (Error) -> Void = { _ in }
    ) async throws {
        await stopStatusUpdates()
        let updates = try await client.statusUpdates(device)
        let task = Task {
            do {
                for try await status in updates { onStatus(status) }
            } catch is CancellationError {
                // Explicit stop is not a status-stream failure.
            } catch {
                onError(error)
            }
        }
        statusTask = task
    }

    func stopStatusUpdates() async {
        guard let task = statusTask else { return }
        statusTask = nil
        task.cancel()
        await task.value
    }

    func cancelAll() async {
        await stopStatusUpdates()
        await client.cancelCurrentOperation()
    }
}
