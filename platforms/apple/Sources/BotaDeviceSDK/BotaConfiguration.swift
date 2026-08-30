@preconcurrency import CoreBluetooth
import Foundation

public struct BotaConfiguration: @unchecked Sendable {
    public var applicationSupportDirectory: URL?
    let runtimeFactory: @Sendable () async throws -> DeviceRuntime

    public init(applicationSupportDirectory: URL? = nil) {
        self.applicationSupportDirectory = applicationSupportDirectory
        let configuredDirectory = applicationSupportDirectory
        runtimeFactory = {
            try Self.validateBluetoothAuthorization()
            let root = configuredDirectory ?? Self.defaultApplicationSupportDirectory()
            let bluetooth = CoreBluetoothHost(driver: CoreBluetoothDriver())
            let mapper = try CoreModelMapper()
            let persistence = FilePersistenceHost(
                rootDirectory: root.appendingPathComponent("State", isDirectory: true)
            )
            let network = URLSessionNetworkHost()
            let material = ApplicationMaterialHost()
            let recordingSink = FileRecordingSinkHost(
                rootDirectory: root.appendingPathComponent("Recordings", isDirectory: true)
            )
            let firmwareBlob = FileFirmwareBlobHost()
            let executor = HostEffectExecutor(
                bluetooth: bluetooth,
                persistence: persistence,
                network: network,
                material: material,
                recordingSink: recordingSink,
                firmwareBlob: firmwareBlob
            )
            return DeviceRuntime(
                engine: CoreEngineActor(abi: try CoreAbiClient(), host: executor),
                capabilities: .all,
                disconnect: { peripheralID in
                    try await bluetooth.disconnect(peripheralID: peripheralID)
                },
                readStatus: { peripheralID in
                    let data = try await bluetooth.read(
                        peripheralID: peripheralID,
                        serviceUUID: BotaBluetoothUUIDs.controlService,
                        characteristicUUID: BotaBluetoothUUIDs.deviceStatus
                    )
                    return try mapper.parseDeviceStatus(data)
                },
                statusUpdates: { peripheralID in
                    let source = try await bluetooth.subscribe(
                        peripheralID: peripheralID,
                        serviceUUID: BotaBluetoothUUIDs.controlService,
                        characteristicUUID: BotaBluetoothUUIDs.deviceStatus
                    )
                    return AsyncThrowingStream { continuation in
                        let task = Task {
                            do {
                                for try await data in source {
                                    continuation.yield(try mapper.parseDeviceStatus(data))
                                }
                                continuation.finish()
                            } catch {
                                continuation.finish(throwing: error)
                            }
                        }
                        continuation.onTermination = { @Sendable _ in task.cancel() }
                    }
                },
                stopStatusUpdates: { peripheralID in
                    try await bluetooth.unsubscribe(
                        peripheralID: peripheralID,
                        serviceUUID: BotaBluetoothUUIDs.controlService,
                        characteristicUUID: BotaBluetoothUUIDs.deviceStatus
                    )
                }
            )
        }
    }

    init(runtimeFactory: @escaping @Sendable () async throws -> DeviceRuntime) {
        applicationSupportDirectory = nil
        self.runtimeFactory = runtimeFactory
    }

    private static func defaultApplicationSupportDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("BotaDeviceSDK", isDirectory: true)
    }

    static func validateBluetoothAuthorization(
        _ authorization: CBManagerAuthorization = CBManager.authorization
    ) throws {
        switch authorization {
        case .denied, .restricted:
            throw BotaDeviceSDKError(
                code: .featureUnavailable,
                operation: .discover,
                retryable: false,
                detail: "Bluetooth access is denied or restricted"
            )
        case .allowedAlways, .notDetermined:
            return
        @unknown default:
            throw BotaDeviceSDKError(
                code: .featureUnavailable,
                operation: .discover,
                retryable: false,
                detail: "Bluetooth authorization state is unsupported"
            )
        }
    }
}
