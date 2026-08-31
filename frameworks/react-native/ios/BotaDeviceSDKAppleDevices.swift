import BotaAppleSDK
import Foundation

protocol BotaDeviceSDKAppleDeviceClient: Sendable {
    func startScan(
        timeoutMilliseconds: UInt64,
        allowDuplicates: Bool
    ) async throws -> AsyncThrowingStream<DiscoveredDevice, Error>
    func cancelCurrentOperation() async throws
    func connect(device: DiscoveredDevice) async throws -> ConnectedDevice
    func reconnect(
        serialNumber: String,
        hint: DeviceReconnectHint
    ) async throws -> ConnectedDevice
    func disconnect() async throws
    func readStatus() async throws -> DeviceStatus
    func statusUpdates() async throws -> AsyncThrowingStream<DeviceStatus, Error>
}

struct BotaDeviceSDKSharedAppleDeviceClient: BotaDeviceSDKAppleDeviceClient {
    private let devices: DeviceManager

    init(client: BotaDeviceClient = .shared) {
        devices = client.devices
    }

    func startScan(
        timeoutMilliseconds: UInt64,
        allowDuplicates: Bool
    ) async throws -> AsyncThrowingStream<DiscoveredDevice, Error> {
        try await devices.startScan(
            timeoutMilliseconds: timeoutMilliseconds,
            allowDuplicates: allowDuplicates
        )
    }

    func cancelCurrentOperation() async throws {
        try await devices.cancelCurrentOperation()
    }

    func connect(device: DiscoveredDevice) async throws -> ConnectedDevice {
        try await devices.connect(device: device)
    }

    func reconnect(
        serialNumber: String,
        hint: DeviceReconnectHint
    ) async throws -> ConnectedDevice {
        try await devices.reconnect(serialNumber: serialNumber, hint: hint)
    }

    func disconnect() async throws {
        try await devices.disconnect()
    }

    func readStatus() async throws -> DeviceStatus {
        try await devices.readStatus()
    }

    func statusUpdates() async throws -> AsyncThrowingStream<DeviceStatus, Error> {
        try await devices.statusUpdates()
    }
}

actor BotaDeviceSDKAppleDevices {
    private struct ActiveScan {
        let id: UUID
        let task: Task<Void, Never>
    }

    private struct ActiveStatusUpdates {
        let id: UUID
        let task: Task<Void, Never>
    }

    private let client: any BotaDeviceSDKAppleDeviceClient
    private var activeScan: ActiveScan?
    private var activeStatusUpdates: ActiveStatusUpdates?

    init(client: any BotaDeviceSDKAppleDeviceClient = BotaDeviceSDKSharedAppleDeviceClient()) {
        self.client = client
    }

    func startScan(
        timeoutMilliseconds: UInt64,
        allowDuplicates: Bool,
        onDevice: @escaping @Sendable (DiscoveredDevice) -> Void,
        onError: @escaping @Sendable (Error) -> Void = { _ in }
    ) async throws {
        await stopScan()
        let stream = try await client.startScan(
            timeoutMilliseconds: timeoutMilliseconds,
            allowDuplicates: allowDuplicates
        )
        let id = UUID()
        let task = Task {
            do {
                for try await device in stream {
                    try Task.checkCancellation()
                    onDevice(device)
                }
            } catch is CancellationError {
                // Explicit stop is not a scan failure.
            } catch {
                onError(error)
            }
            scanFinished(id: id)
        }
        activeScan = ActiveScan(id: id, task: task)
    }

    func stopScan() async {
        guard let scan = activeScan else { return }
        activeScan = nil
        scan.task.cancel()
        try? await client.cancelCurrentOperation()
        await scan.task.value
    }

    func connect(_ device: DiscoveredDevice) async throws -> ConnectedDevice {
        await stopScan()
        await stopStatusUpdates()
        return try await client.connect(device: device)
    }

    func reconnect(
        serialNumber: String,
        hint: DeviceReconnectHint
    ) async throws -> ConnectedDevice {
        await stopScan()
        await stopStatusUpdates()
        return try await client.reconnect(serialNumber: serialNumber, hint: hint)
    }

    func disconnect() async throws {
        await stopScan()
        await stopStatusUpdates()
        try await client.disconnect()
    }

    func readStatus() async throws -> DeviceStatus {
        try await client.readStatus()
    }

    func startStatusUpdates(
        onStatus: @escaping @Sendable (DeviceStatus) -> Void,
        onError: @escaping @Sendable (Error) -> Void = { _ in }
    ) async throws {
        await stopStatusUpdates()
        let stream = try await client.statusUpdates()
        let id = UUID()
        let task = Task {
            do {
                for try await status in stream {
                    try Task.checkCancellation()
                    onStatus(status)
                }
            } catch is CancellationError {
                // Explicit stop is not a status subscription failure.
            } catch {
                onError(error)
            }
            statusUpdatesFinished(id: id)
        }
        activeStatusUpdates = ActiveStatusUpdates(id: id, task: task)
    }

    func stopStatusUpdates() async {
        guard let updates = activeStatusUpdates else { return }
        activeStatusUpdates = nil
        updates.task.cancel()
        await updates.task.value
    }

    func stopAll() async {
        await stopScan()
        await stopStatusUpdates()
    }

    private func scanFinished(id: UUID) {
        if activeScan?.id == id {
            activeScan = nil
        }
    }

    private func statusUpdatesFinished(id: UUID) {
        if activeStatusUpdates?.id == id {
            activeStatusUpdates = nil
        }
    }
}
