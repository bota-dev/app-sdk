import BotaDeviceSDKC
import Foundation

public struct ProvisioningMaterialRequest: Sendable {
    public let serialNumber: String
    public let nonce: Data
    public let devicePublicKey: Data

    public init(serialNumber: String, nonce: Data, devicePublicKey: Data) {
        self.serialNumber = serialNumber
        self.nonce = nonce
        self.devicePublicKey = devicePublicKey
    }
}

struct FactoryResetMaterialRequest: Sendable {
    let serialNumber: String
    let nonce: Data
}

public struct ProvisioningMaterial: Sendable {
    public let apiEndpoint: Data
    public let deviceToken: Data
    public let mtu: UInt64

    public init(apiEndpoint: Data, deviceToken: Data, mtu: UInt64) {
        self.apiEndpoint = apiEndpoint
        self.deviceToken = deviceToken
        self.mtu = mtu
    }
}

public typealias ProvisioningMaterialProvider = @Sendable (ProvisioningMaterialRequest) async throws -> ProvisioningMaterial
typealias ProvisioningApplicationMaterial = ProvisioningMaterial
typealias FactoryResetMaterialProvider = @Sendable (FactoryResetMaterialRequest) async throws -> Data

actor ApplicationMaterialHost: MaterialHost {
    private var provisioningProviders: [String: ProvisioningMaterialProvider] = [:]
    private var resetProviders: [String: FactoryResetMaterialProvider] = [:]

    func registerProvisioning(id: String, provider: @escaping ProvisioningMaterialProvider) {
        provisioningProviders[id] = provider
    }

    func registerFactoryReset(id: String, provider: @escaping FactoryResetMaterialProvider) {
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
