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
            let connection = DeviceConnectionRegistry()
            let persistence = FilePersistenceHost(
                rootDirectory: root.appendingPathComponent("State", isDirectory: true)
            )
            let network = URLSessionNetworkHost()
            let material = ApplicationMaterialHost()
            let recordingSink = FileRecordingSinkHost(
                rootDirectory: root.appendingPathComponent("Recordings", isDirectory: true)
            )
            let firmwareBlob = FileFirmwareBlobHost()
            let firmwareDirectory = root.appendingPathComponent("Firmware", isDirectory: true)
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
                connection: connection,
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
                },
                directRead: { peripheralID, serviceUUID, characteristicUUID in
                    try await bluetooth.read(
                        peripheralID: peripheralID,
                        serviceUUID: serviceUUID,
                        characteristicUUID: characteristicUUID
                    )
                },
                directWrite: { peripheralID, serviceUUID, characteristicUUID, data in
                    try await bluetooth.write(
                        peripheralID: peripheralID,
                        serviceUUID: serviceUUID,
                        characteristicUUID: characteristicUUID,
                        data: data
                    )
                },
                directSubscribe: { peripheralID, serviceUUID, characteristicUUID in
                    try await bluetooth.subscribe(
                        peripheralID: peripheralID,
                        serviceUUID: serviceUUID,
                        characteristicUUID: characteristicUUID
                    )
                },
                directUnsubscribe: { peripheralID, serviceUUID, characteristicUUID in
                    try await bluetooth.unsubscribe(
                        peripheralID: peripheralID,
                        serviceUUID: serviceUUID,
                        characteristicUUID: characteristicUUID
                    )
                },
                parseRecordingState: { try mapper.parseRecordingState($0) },
                parseRecordingControlResult: { try mapper.parseRecordingControlResult($0) },
                createRecordingControlCommand: { try mapper.createRecordingControlCommand($0) },
                parseWiFiConfigResult: { try mapper.parseWiFiConfigResult($0) },
                parseWiFiStatusInfo: { try mapper.parseWiFiStatusInfo($0) },
                parseWiFiScanResult: { try mapper.parseWiFiScanResult($0) },
                createWiFiGrantPacket: { try mapper.createWiFiGrantPacket($0) },
                createWiFiCredentialPacket: { ssid, password in
                    try mapper.createWiFiCredentialPacket(ssid: ssid, password: password)
                },
                createWiFiScanCommand: { try mapper.createWiFiScanCommand() },
                createProvisioningChunks: { data, mtu in
                    try mapper.createProvisioningChunks(data, mtu: mtu)
                },
                createTimeSyncData: { epochMilliseconds, timezoneOffsetMinutes in
                    try mapper.createTimeSyncData(
                        epochMilliseconds: epochMilliseconds,
                        timezoneOffsetMinutes: timezoneOffsetMinutes
                    )
                },
                parseConnectionSettings: { data in try mapper.parseConnectionSettings(data) },
                serializeConnectionSettings: { settings, model in
                    try mapper.serializeConnectionSettings(settings, model: model)
                },
                encodeDeviceCommand: { command in try mapper.encodeDeviceCommand(command) },
                parseRecordingList: { data in try mapper.parseRecordingList(data) },
                createTransferCommand: { command in try mapper.createTransferCommand(command) },
                recordingFileURL: { sinkID in try await recordingSink.fileURL(for: sinkID) },
                registerFirmwareDownload: { id, request, fileURL in
                    try FileManager.default.createDirectory(
                        at: firmwareDirectory,
                        withIntermediateDirectories: true
                    )
                    await network.registerDownload(id: id, request: request, destinationURL: fileURL)
                    await firmwareBlob.register(downloadID: id, fileURL: fileURL)
                },
                unregisterFirmwareDownload: { id in
                    await network.unregister(id: id)
                    await firmwareBlob.unregister(downloadID: id)
                },
                firmwareFileURL: { id in
                    firmwareDirectory.appendingPathComponent("\(id).firmware")
                },
                registerProvisioning: { id, provider in
                    await material.registerProvisioning(id: id, provider: provider)
                },
                registerFactoryReset: { id, provider in
                    await material.registerFactoryReset(id: id, provider: provider)
                },
                unregisterMaterial: { id in await material.unregister(id: id) },
                registerFactoryResetGeneration: { commandID, generation in
                    await persistence.registerFactoryReset(
                        commandID: commandID,
                        bindingGeneration: generation
                    )
                },
                unregisterFactoryResetGeneration: { commandID in
                    await persistence.unregisterFactoryReset(commandID: commandID)
                },
                loadPendingFactoryReset: { try await persistence.loadFactoryResetResult() }
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
        // Preserve the pre-1.0 storage namespace across the public module rename.
        return base.appendingPathComponent("BotaDeviceSDK", isDirectory: true)
    }

    static func validateBluetoothAuthorization(
        _ authorization: CBManagerAuthorization = CBManager.authorization
    ) throws {
        switch authorization {
        case .denied, .restricted:
            throw BotaSDKError(
                code: .featureUnavailable,
                operation: .discover,
                retryable: false,
                detail: "Bluetooth access is denied or restricted"
            )
        case .allowedAlways, .notDetermined:
            return
        @unknown default:
            throw BotaSDKError(
                code: .featureUnavailable,
                operation: .discover,
                retryable: false,
                detail: "Bluetooth authorization state is unsupported"
            )
        }
    }
}
