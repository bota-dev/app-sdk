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
            let encryptedUploadV2Capabilities = EncryptedUploadV2CapabilityReader(
                read: { peripheralID, serviceUUID, characteristicUUID in
                    try await bluetooth.read(
                        peripheralID: peripheralID,
                        serviceUUID: serviceUUID,
                        characteristicUUID: characteristicUUID
                    )
                },
                decode: { try mapper.decodeEncryptedUploadV2Capabilities($0) }
            )
            let connection = DeviceConnectionRegistry()
            let persistence = FilePersistenceHost(
                rootDirectory: root.appendingPathComponent("State", isDirectory: true)
            )
            let network = URLSessionNetworkHost()
            let material = ApplicationMaterialHost()
            let encryptedUploadV2Material = EncryptedUploadV2MaterialRegistry()
            let encryptedUploadV2SignedBlobWriter = EncryptedUploadV2SignedBlobWriter(
                bluetooth: bluetooth,
                mapper: mapper
            )
            let encryptedUploadV2TransferControl = EncryptedUploadV2TransferControl(
                bluetooth: bluetooth,
                mapper: mapper
            )
            let encryptedUploadV2WriteIDs = EncryptedUploadV2WriteIDGenerator()
            let currentPeripheralID: @Sendable () async throws -> String = {
                guard let device = await connection.current else {
                    throw NativeHostError.missingResource("encrypted upload v2 connection")
                }
                return device.id
            }
            let encryptedUploadV2Transfer = EncryptedUploadV2TransferHost(
                rootDirectory: root.appendingPathComponent("EncryptedUploadV2", isDirectory: true),
                mapper: mapper,
                transferControl: encryptedUploadV2TransferControl,
                resolvePeripheralID: currentPeripheralID,
                services: .init(
                    materialRegistry: encryptedUploadV2Material,
                    sendSignedDocument: { kind, writeID, document, maximumDocumentBytes in
                        try await encryptedUploadV2SignedBlobWriter.send(
                            peripheralID: currentPeripheralID(),
                            kind: kind,
                            writeID: writeID,
                            document: document,
                            maximumDocumentBytes: maximumDocumentBytes
                        )
                    },
                    uploadCiphertext: { request, fileURL in
                        let (_, response) = try await URLSession.shared.upload(for: request, fromFile: fileURL)
                        guard let response = response as? HTTPURLResponse,
                              (200 ..< 300).contains(response.statusCode)
                        else { throw NativeHostError.httpStatus((response as? HTTPURLResponse)?.statusCode ?? 0) }
                    },
                    confirmTransfer: { transportSessionID, frame in
                        try await encryptedUploadV2TransferControl.confirmActiveTransferFrame(
                            transportSessionID: transportSessionID,
                            frame: frame
                        )
                    },
                    nextWriteID: { encryptedUploadV2WriteIDs.next() }
                )
            )
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
                firmwareBlob: firmwareBlob,
                encryptedUploadV2: encryptedUploadV2Transfer
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
                readEncryptedUploadV2Capabilities: { peripheralID in
                    try await encryptedUploadV2Capabilities.readFresh(peripheralID: peripheralID)
                },
                encryptedUploadV2Checkpoint: { serialNumber, recordingUUID, recordingGeneration in
                    try await encryptedUploadV2Transfer.checkpoint(
                        serialNumber: serialNumber,
                        recordingUUID: recordingUUID,
                        recordingGeneration: recordingGeneration
                    )
                },
                encryptedUploadV2MaximumWriteLength: { peripheralID in
                    try await bluetooth.maximumWriteValueLength(peripheralID: peripheralID)
                },
                registerEncryptedUploadV2Material: { id, material in
                    try await encryptedUploadV2Material.register(id: id, provider: material.provider)
                },
                terminateEncryptedUploadV2Material: { id, outcome in
                    try? await encryptedUploadV2Material.terminate(id: id, outcome: outcome)
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
                registerStreamingSink: { sinkID, chunkSize, flushInterval, destinationProvider, finalize in
                    try await recordingSink.registerStreaming(
                        sinkID: sinkID,
                        chunkSizeBytes: chunkSize,
                        flushIntervalMilliseconds: flushInterval,
                        destinationProvider: destinationProvider,
                        finalize: finalize
                    )
                },
                unregisterStreamingSink: { sinkID in
                    await recordingSink.unregisterStreaming(sinkID: sinkID)
                },
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
                registerFactoryResetResultPersister: { commandID, persister in
                    await persistence.registerFactoryResetResultPersister(
                        commandID: commandID,
                        persister: persister
                    )
                },
                unregisterFactoryResetResultPersister: { commandID in
                    await persistence.unregisterFactoryResetResultPersister(commandID: commandID)
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

private final class EncryptedUploadV2WriteIDGenerator: @unchecked Sendable {
    private let lock = NSLock()
    private var value: UInt32 = 0

    func next() -> UInt32 {
        lock.withLock {
            value &+= 1
            if value == 0 { value = 1 }
            return value
        }
    }
}
