import BotaDeviceSDKC
import Foundation
import Security

protocol KeychainBackend: Sendable {
    func read(service: String, key: String) throws -> Data?
    func write(service: String, key: String, value: Data) throws
    func delete(service: String, key: String) throws
}

struct SecurityKeychainBackend: KeychainBackend {
    func read(service: String, key: String) throws -> Data? {
        var query = baseQuery(service: service, key: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw NativeHostError.keychainStatus(status)
        }
        return data
    }

    func write(service: String, key: String, value: Data) throws {
        let query = baseQuery(service: service, key: key)
        let update = [kSecValueData as String: value]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = value
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(item as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw NativeHostError.keychainStatus(addStatus) }
        } else if status != errSecSuccess {
            throw NativeHostError.keychainStatus(status)
        }
    }

    func delete(service: String, key: String) throws {
        let status = SecItemDelete(baseQuery(service: service, key: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NativeHostError.keychainStatus(status)
        }
    }

    private func baseQuery(service: String, key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}

actor KeychainSecureStorageHost: PersistenceHost {
    private let service: String
    private let backend: any KeychainBackend

    init(service: String = "dev.bota.device-sdk", backend: any KeychainBackend = SecurityKeychainBackend()) {
        self.service = service
        self.backend = backend
    }

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        AsyncThrowingStream { continuation in
            do {
                let key = try requiredText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_KEY))
                guard !key.isEmpty, key.utf8.count <= 128 else { throw NativeHostError.invalidOpaqueID(key) }
                switch effect {
                case .secureStorageRead:
                    var fields: [CoreField] = [
                        .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_KEY), value: key),
                    ]
                    if let value = try backend.read(service: service, key: key) {
                        fields.append(.bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_VALUE), value: value))
                    }
                    continuation.yield(.init(
                        kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_SECRET_LOADED),
                        fields: fields
                    ))
                case .secureStorageWrite:
                    let value = try requiredBytes(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_VALUE))
                    try backend.write(service: service, key: key, value: value)
                    continuation.yield(stored(key))
                case .secureStorageDelete:
                    try backend.delete(service: service, key: key)
                    continuation.yield(stored(key))
                default:
                    throw NativeHostError.invalidEffect(effect.kind)
                }
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
    }

    private func stored(_ key: String) -> CoreHostEventPayload {
        .init(
            kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_SECRET_STORED),
            fields: [.text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_KEY), value: key)]
        )
    }
}

enum NativeHostError: Error, Equatable, Sendable {
    case invalidEffect(UInt32)
    case missingField(UInt32)
    case invalidOpaqueID(String)
    case missingResource(String)
    case staleFactoryResetResult
    case keychainStatus(OSStatus)
    case invalidChunkLength(UInt64)
    case httpStatus(Int)
}

func requiredText(_ effect: CoreEffect, _ id: UInt32) throws -> String {
    for field in effect.packet.fields {
        if case let .text(fieldID, value) = field, fieldID == id { return value }
    }
    throw NativeHostError.missingField(id)
}

func requiredBytes(_ effect: CoreEffect, _ id: UInt32) throws -> Data {
    for field in effect.packet.fields {
        if case let .bytes(fieldID, value) = field, fieldID == id { return value }
    }
    throw NativeHostError.missingField(id)
}

func requiredUnsigned(_ effect: CoreEffect, _ id: UInt32) throws -> UInt64 {
    guard let value = effect.packet.fields.unsigned(id) else { throw NativeHostError.missingField(id) }
    return value
}

func optionalUnsigned(_ effect: CoreEffect, _ id: UInt32) -> UInt64? {
    effect.packet.fields.unsigned(id)
}
