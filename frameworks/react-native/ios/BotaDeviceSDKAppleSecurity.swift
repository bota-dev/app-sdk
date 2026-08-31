import BotaAppleSDK
import Foundation

struct BotaDeviceSDKAppleProvisioningRequest: Equatable, Sendable {
    let requestID: String
    let serialNumber: String
    let nonce: String
    let devicePublicKey: String
}

protocol BotaDeviceSDKAppleSecurityClient: Sendable {
    func provision(
        _ device: ConnectedDevice,
        using provider: @escaping ProvisioningMaterialProvider
    ) async throws
    func deprovision(_ device: ConnectedDevice) async throws
    func cancelCurrentOperation() async throws
}

struct BotaDeviceSDKSharedAppleSecurityClient: BotaDeviceSDKAppleSecurityClient {
    private let provisioning: ProvisioningManager

    init(client: BotaDeviceClient = .shared) {
        provisioning = client.provisioning
    }

    func provision(
        _ device: ConnectedDevice,
        using provider: @escaping ProvisioningMaterialProvider
    ) async throws {
        try await provisioning.provision(
            device,
            materialID: UUID().uuidString,
            using: provider
        )
    }

    func deprovision(_ device: ConnectedDevice) async throws {
        try await provisioning.deprovision(device)
    }

    func cancelCurrentOperation() async throws {
        try await provisioning.cancelCurrentOperation()
    }
}

actor BotaDeviceSDKAppleSecurity {
    private enum MaterialError: LocalizedError {
        case cancelled
        case rejected(String)
        case unknownRequest

        var errorDescription: String? {
            switch self {
            case .cancelled: "application material request was cancelled"
            case let .rejected(message): message
            case .unknownRequest: "application material request is no longer pending"
            }
        }
    }

    private let client: any BotaDeviceSDKAppleSecurityClient
    private var provisioningRequests: [
        String: CheckedContinuation<ProvisioningMaterial, Error>
    ] = [:]

    init(client: any BotaDeviceSDKAppleSecurityClient = BotaDeviceSDKSharedAppleSecurityClient()) {
        self.client = client
    }

    func provision(
        _ device: ConnectedDevice,
        onMaterialRequest: @escaping @Sendable (BotaDeviceSDKAppleProvisioningRequest) -> Void
    ) async throws {
        try await client.provision(device) { request in
            try await self.requestProvisioningMaterial(request, onRequest: onMaterialRequest)
        }
    }

    func deprovision(_ device: ConnectedDevice) async throws {
        try await client.deprovision(device)
    }

    func resolveProvisioningMaterial(
        requestID: String,
        apiEndpoint: String,
        deviceToken: String,
        mtu: UInt64
    ) throws {
        guard let continuation = provisioningRequests.removeValue(forKey: requestID) else {
            throw MaterialError.unknownRequest
        }
        continuation.resume(returning: ProvisioningMaterial(
            apiEndpoint: Data(apiEndpoint.utf8),
            deviceToken: Data(deviceToken.utf8),
            mtu: mtu
        ))
    }

    func rejectApplicationMaterial(requestID: String, message: String) throws {
        guard let continuation = provisioningRequests.removeValue(forKey: requestID) else {
            throw MaterialError.unknownRequest
        }
        continuation.resume(throwing: MaterialError.rejected(message))
    }

    func cancelAll() async {
        let pending = provisioningRequests.values
        provisioningRequests.removeAll()
        pending.forEach { $0.resume(throwing: MaterialError.cancelled) }
        try? await client.cancelCurrentOperation()
    }

    private func requestProvisioningMaterial(
        _ request: ProvisioningMaterialRequest,
        onRequest: @escaping @Sendable (BotaDeviceSDKAppleProvisioningRequest) -> Void
    ) async throws -> ProvisioningMaterial {
        let requestID = UUID().uuidString
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                provisioningRequests[requestID] = continuation
                onRequest(.init(
                    requestID: requestID,
                    serialNumber: request.serialNumber,
                    nonce: request.nonce.hexString,
                    devicePublicKey: request.devicePublicKey.hexString
                ))
            }
        } onCancel: {
            Task { await self.cancel(requestID: requestID) }
        }
    }

    private func cancel(requestID: String) {
        provisioningRequests.removeValue(forKey: requestID)?.resume(
            throwing: MaterialError.cancelled
        )
    }
}

private extension Data {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
