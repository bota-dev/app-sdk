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
        let value: Data
        do {
            value = try await read(peripheralID, BotaBluetoothUUIDs.uploadExtensionsService,
                                   BotaBluetoothUUIDs.storageTransferCapabilitiesExtended)
        } catch let error as CentralDriverError {
            switch error {
            case .serviceNotFound(BotaBluetoothUUIDs.uploadExtensionsService),
                 .characteristicNotFound(BotaBluetoothUUIDs.storageTransferCapabilitiesExtended):
                value = try await read(peripheralID, BotaBluetoothUUIDs.storageService,
                                       BotaBluetoothUUIDs.storageTransferCapabilitiesV2)
            default: throw error
            }
        }
        return EncryptedUploadV2CapabilitySnapshot(
            rawValue: value,
            sha256: Data(SHA256.hash(data: value)),
            capabilities: .init(value: try decode(value))
        )
    }
}
