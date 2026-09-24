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
