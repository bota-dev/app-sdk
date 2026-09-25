import BotaAppSDK
import Foundation

/// Holds v2 application material entirely in native memory. JavaScript receives only
/// the returned opaque identifier and cannot inspect the registered material.
public enum BotaDeviceSDKEncryptedUploadV2Materials {
    private static let storage = BotaDeviceSDKEncryptedUploadV2MaterialStorage()

    public static func register(_ material: EncryptedUploadV2Material) -> String {
        storage.register(material)
    }

    @discardableResult
    public static func remove(_ registrationID: String) -> EncryptedUploadV2Material? {
        storage.remove(registrationID)
    }

    public static func readAuthNonce(_ operationID: String) async throws -> Data {
        let entry = try storage.context(operationID)
        let nonce = try await entry.value.readAuthNonce()
        guard try storage.context(operationID).lease == entry.lease else {
            throw CancellationError()
        }
        return nonce
    }

    public static func release(_ registrationID: String) async {
        if let material = storage.remove(registrationID) { await material.cancelPreparation() }
    }

    static func registerContext(_ operationID: String, context: EncryptedUploadV2ProviderContext) throws {
        try storage.registerContext(operationID, value: context)
    }

    static func removeContext(_ operationID: String) { storage.removeContext(operationID) }

    static func consume(
        _ registrationID: String,
        recording: EncryptedUploadV2Recording,
        uploadSessionID: UUID,
        ownerRevision: UInt32,
        securityPolicy: String
    ) throws -> EncryptedUploadV2Material {
        try storage.consume(
            registrationID,
            recording: recording,
            uploadSessionID: uploadSessionID,
            ownerRevision: ownerRevision,
            securityPolicy: securityPolicy
        )
    }
}

private final class BotaDeviceSDKEncryptedUploadV2MaterialStorage: @unchecked Sendable {
    struct Context: Sendable {
        let lease: UUID
        let value: EncryptedUploadV2ProviderContext
    }
    private enum RegistrationError: LocalizedError {
        case invalidSelection
        case unknownRegistration

        var errorDescription: String? {
            switch self {
            case .invalidSelection:
                "encrypted upload v2 material does not match the selected profile"
            case .unknownRegistration:
                "encrypted upload v2 material registration is unavailable"
            }
        }
    }

    private let lock = NSLock()
    private var materials: [String: EncryptedUploadV2Material] = [:]
    private var contexts: [String: Context] = [:]

    func registerContext(_ operationID: String, value: EncryptedUploadV2ProviderContext) throws {
        try lock.withLock {
            guard contexts[operationID] == nil else { throw RegistrationError.invalidSelection }
            contexts[operationID] = Context(lease: UUID(), value: value)
        }
    }

    func context(_ operationID: String) throws -> Context {
        try lock.withLock {
            guard let context = contexts[operationID] else { throw RegistrationError.unknownRegistration }
            return context
        }
    }

    func removeContext(_ operationID: String) { _ = lock.withLock { contexts.removeValue(forKey: operationID) } }

    func register(_ material: EncryptedUploadV2Material) -> String {
        let registrationID = UUID().uuidString.lowercased()
        lock.withLock { materials[registrationID] = material }
        return registrationID
    }

    func remove(_ registrationID: String) -> EncryptedUploadV2Material? {
        lock.withLock { materials.removeValue(forKey: registrationID) }
    }

    func consume(
        _ registrationID: String,
        recording: EncryptedUploadV2Recording,
        uploadSessionID: UUID,
        ownerRevision: UInt32,
        securityPolicy: String
    ) throws -> EncryptedUploadV2Material {
        try lock.withLock {
            guard let material = materials[registrationID] else {
                throw RegistrationError.unknownRegistration
            }
            guard material.recordingID == recording.uuid,
                  material.uploadSessionID == uploadSessionID,
                  material.ownerRevision == ownerRevision,
                  matches(material.policy, securityPolicy)
            else {
                throw RegistrationError.invalidSelection
            }
            materials.removeValue(forKey: registrationID)
            return material
        }
    }

    private func matches(
        _ policy: EncryptedUploadV2SecurityPolicy,
        _ value: String
    ) -> Bool {
        switch (policy, value) {
        case (.legacyAllowed, "legacy_allowed"),
             (.v2Preferred, "v2_preferred"),
             (.v2Required, "v2_required"):
            true
        default:
            false
        }
    }
}
