import BotaDeviceSDKC
import Foundation

struct ProvisioningMaterialRequest: Sendable {
    let serialNumber: String
    let nonce: Data
    let devicePublicKey: Data
}

struct FactoryResetGrantRequest: Sendable {
    let serialNumber: String
    let nonce: Data
}

struct ProvisioningApplicationMaterial: Sendable {
    let apiEndpoint: Data
    let deviceToken: Data
    let mtu: UInt64
}

actor ApplicationMaterialHost: MaterialHost {
    typealias ProvisioningProvider = @Sendable (ProvisioningMaterialRequest) async throws -> ProvisioningApplicationMaterial
    typealias ResetProvider = @Sendable (FactoryResetGrantRequest) async throws -> Data

    private var provisioningProviders: [String: ProvisioningProvider] = [:]
    private var resetProviders: [String: ResetProvider] = [:]

    func registerProvisioning(id: String, provider: @escaping ProvisioningProvider) {
        provisioningProviders[id] = provider
    }

    func registerFactoryReset(id: String, provider: @escaping ResetProvider) {
        resetProviders[id] = provider
    }

    func unregister(id: String) {
        provisioningProviders[id] = nil
        resetProviders[id] = nil
    }

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        let pair = AsyncThrowingStream<CoreHostEventPayload, Error>.makeStream()
        let task = Task {
            do {
                switch effect {
                case .prepareProvisioning:
                    let id = try requiredText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_MATERIAL_ID))
                    guard let provider = provisioningProviders[id] else {
                        throw NativeHostError.missingResource(id)
                    }
                    let material = try await provider(.init(
                        serialNumber: try requiredText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER)),
                        nonce: try requiredBytes(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_NONCE)),
                        devicePublicKey: try requiredBytes(
                            effect,
                            UInt32(BOTA_DEVICE_SDK_V1_FIELD_DEVICE_PUBLIC_KEY)
                        )
                    ))
                    pair.continuation.yield(.init(
                        kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_PROVISIONING_MATERIAL_PREPARED),
                        fields: [
                            .bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_API_ENDPOINT), value: material.apiEndpoint),
                            .bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DEVICE_TOKEN), value: material.deviceToken),
                            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_MTU), value: material.mtu),
                        ]
                    ))
                case .prepareFactoryResetGrant:
                    let id = try requiredText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_GRANT_ID))
                    guard let provider = resetProviders[id] else { throw NativeHostError.missingResource(id) }
                    let grant = try await provider(.init(
                        serialNumber: try requiredText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER)),
                        nonce: try requiredBytes(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_NONCE))
                    ))
                    pair.continuation.yield(.init(
                        kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_FACTORY_RESET_GRANT_PREPARED),
                        fields: [.bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_GRANT), value: grant)]
                    ))
                default:
                    throw NativeHostError.invalidEffect(effect.kind)
                }
                pair.continuation.finish()
            } catch {
                pair.continuation.finish(throwing: error)
            }
        }
        pair.continuation.onTermination = { @Sendable _ in task.cancel() }
        return pair.stream
    }
}
