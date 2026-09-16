import CryptoKit
import Foundation

struct EncryptedUploadV2CapabilityReader: Sendable {
    typealias Read = @Sendable (String, String, String) async throws -> Data
    typealias Decode = @Sendable (Data) throws -> EncryptedUploadV2CapabilitiesValue

    private let read: Read
    private let decode: Decode

    init(read: @escaping Read, decode: @escaping Decode) {
        self.read = read
        self.decode = decode
    }

    func readFresh(peripheralID: String) async throws -> EncryptedUploadV2CapabilitySnapshot {
        let value = try await read(
            peripheralID,
            BotaBluetoothUUIDs.storageService,
            BotaBluetoothUUIDs.storageTransferCapabilitiesV2
        )
        return EncryptedUploadV2CapabilitySnapshot(
            rawValue: value,
            sha256: Data(SHA256.hash(data: value)),
            capabilities: .init(value: try decode(value))
        )
    }
}
