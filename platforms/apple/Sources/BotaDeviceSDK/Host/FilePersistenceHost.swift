import BotaDeviceSDKC
import Foundation

struct PersistedFactoryResetResult: Codable, Equatable, Sendable {
    let commandID: String
    let resultCode: UInt64
    let deletedRecordingCount: UInt64
    let bindingGeneration: UInt64?

    init(
        commandID: String,
        resultCode: UInt64,
        deletedRecordingCount: UInt64,
        bindingGeneration: UInt64? = nil
    ) {
        self.commandID = commandID
        self.resultCode = resultCode
        self.deletedRecordingCount = deletedRecordingCount
        self.bindingGeneration = bindingGeneration
    }
}

private struct PersistedConnectionIdentity: Codable {
    let serialNumber: String
    let peripheralID: String
    let name: String?
    let advertisedAddress: String?
    let rssi: Int64?
}

actor FilePersistenceHost: PersistenceHost {
    private let fileManager: FileManager
    private let rootDirectory: URL
    private let secureStorage: any PersistenceHost
    private var factoryResetGenerations: [String: UInt64] = [:]

    init(
        rootDirectory: URL,
        secureStorage: any PersistenceHost = KeychainSecureStorageHost(),
        fileManager: FileManager = .default
    ) {
        self.rootDirectory = rootDirectory
        self.secureStorage = secureStorage
        self.fileManager = fileManager
    }

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        switch effect {
        case .secureStorageRead, .secureStorageWrite, .secureStorageDelete:
            return await secureStorage.execute(effect)
        default:
            break
        }
        return AsyncThrowingStream { continuation in
            do {
                try ensureRoot()
                switch effect {
                case .persistenceLoadCheckpoint:
                    var fields: [CoreField] = []
                    if fileManager.fileExists(atPath: checkpointURL.path) {
                        fields.append(.bytes(
                            id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CHECKPOINT),
                            value: try Data(contentsOf: checkpointURL)
                        ))
                    }
                    continuation.yield(.init(
                        kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_CHECKPOINT_LOADED),
                        fields: fields
                    ))
                case .persistenceSaveCheckpoint:
                    try atomicWrite(
                        try requiredBytes(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_CHECKPOINT)),
                        to: checkpointURL
                    )
                    continuation.yield(checkpointSaved())
                case .persistenceDeleteCheckpoint:
                    try removeIfPresent(checkpointURL)
                    continuation.yield(checkpointSaved())
                case .persistenceSaveConnectionIdentity:
                    try saveConnectionIdentity(effect)
                    continuation.yield(.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_CONNECTION_IDENTITY_SAVED)))
                case .persistenceSaveFactoryResetResult:
                    try saveFactoryResetResult(effect)
                    continuation.yield(.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_FACTORY_RESET_RESULT_SAVED)))
                case .persistenceDeleteFactoryResetResult:
                    try deleteFactoryResetResult(effect)
                    continuation.yield(.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_FACTORY_RESET_RESULT_DELETED)))
                default:
                    throw NativeHostError.invalidEffect(effect.kind)
                }
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
    }

    func loadFactoryResetResult() throws -> PersistedFactoryResetResult? {
        guard fileManager.fileExists(atPath: resetURL.path) else { return nil }
        return try JSONDecoder().decode(PersistedFactoryResetResult.self, from: Data(contentsOf: resetURL))
    }

    func registerFactoryReset(commandID: String, bindingGeneration: UInt64) {
        factoryResetGenerations[commandID] = bindingGeneration
    }

    func unregisterFactoryReset(commandID: String) {
        factoryResetGenerations[commandID] = nil
    }

    private var checkpointURL: URL { rootDirectory.appendingPathComponent("workflow-checkpoint.bin") }
    private var identityURL: URL { rootDirectory.appendingPathComponent("connection-identity.json") }
    private var resetURL: URL { rootDirectory.appendingPathComponent("factory-reset-result.json") }

    private func ensureRoot() throws {
        try fileManager.createDirectory(at: rootDirectory, withIntermediateDirectories: true)
    }

    private func atomicWrite(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: .atomic)
#if os(iOS)
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: url.path
        )
#endif
    }

    private func removeIfPresent(_ url: URL) throws {
        if fileManager.fileExists(atPath: url.path) { try fileManager.removeItem(at: url) }
    }

    private func saveConnectionIdentity(_ effect: CoreEffect) throws {
        let identity = PersistedConnectionIdentity(
            serialNumber: try requiredText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER)),
            peripheralID: try requiredText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID)),
            name: optionalText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_NAME)),
            advertisedAddress: optionalText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_ADVERTISED_ADDRESS)),
            rssi: optionalSigned(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_RSSI))
        )
        try atomicWrite(try JSONEncoder().encode(identity), to: identityURL)
    }

    private func saveFactoryResetResult(_ effect: CoreEffect) throws {
        let commandID = try requiredText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND_ID))
        let result = PersistedFactoryResetResult(
            commandID: commandID,
            resultCode: try requiredUnsigned(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_RESULT_CODE)),
            deletedRecordingCount: try requiredUnsigned(
                effect,
                UInt32(BOTA_DEVICE_SDK_V1_FIELD_DELETED_RECORDING_COUNT)
            ),
            bindingGeneration: factoryResetGenerations[commandID]
        )
        try atomicWrite(try JSONEncoder().encode(result), to: resetURL)
    }

    private func deleteFactoryResetResult(_ effect: CoreEffect) throws {
        let commandID = try requiredText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMMAND_ID))
        guard let saved = try loadFactoryResetResult() else { return }
        guard saved.commandID == commandID else { throw NativeHostError.staleFactoryResetResult }
        try fileManager.removeItem(at: resetURL)
        factoryResetGenerations[commandID] = nil
    }

    private func checkpointSaved() -> CoreHostEventPayload {
        .init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_CHECKPOINT_SAVED))
    }
}

private func optionalText(_ effect: CoreEffect, _ id: UInt32) -> String? {
    for field in effect.packet.fields {
        if case let .text(fieldID, value) = field, fieldID == id { return value }
    }
    return nil
}

private func optionalSigned(_ effect: CoreEffect, _ id: UInt32) -> Int64? {
    for field in effect.packet.fields {
        if case let .signed(fieldID, value) = field, fieldID == id { return value }
    }
    return nil
}
