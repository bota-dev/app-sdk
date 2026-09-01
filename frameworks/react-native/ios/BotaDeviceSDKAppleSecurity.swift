import BotaAppleSDK
import Foundation

struct BotaDeviceSDKAppleProvisioningRequest: Equatable, Sendable {
    let requestID: String
    let serialNumber: String
    let nonce: String
    let devicePublicKey: String
}

struct BotaDeviceSDKAppleFactoryResetRequest: Equatable, Sendable {
    let requestID: String
    let serialNumber: String
    let nonce: String
    let commandID: String
    let bindingGeneration: UInt64
}

protocol BotaDeviceSDKAppleSecurityClient: Sendable {
    func isProvisioned(_ device: ConnectedDevice) async throws -> Bool
    func readPublicKey(from device: ConnectedDevice) async throws -> String?
    func readAuthNonce(from device: ConnectedDevice) async throws -> String?
    func setAPIEndpoint(_ environment: DeviceAPIEnvironment, on device: ConnectedDevice) async throws
    func deliverCertificate(
        _ certificatePEM: String,
        privateKeyPEM: String,
        to device: ConnectedDevice
    ) async throws
    func deliverBackendPublicKey(_ publicKey: Data, to device: ConnectedDevice) async throws
    func writeGrant(_ grantBlob: String, to device: ConnectedDevice) async throws
    func syncTime(_ device: ConnectedDevice) async throws
    func requestStartRecording(
        _ device: ConnectedDevice,
        grantBlob: String
    ) async throws -> RecordingControlResult
    func requestStopRecording(
        _ device: ConnectedDevice,
        grantBlob: String
    ) async throws -> RecordingControlResult
    func readRecordingState(from device: ConnectedDevice) async throws -> RecordingState
    func recordingStateUpdates(
        _ device: ConnectedDevice
    ) async throws -> AsyncThrowingStream<RecordingState, Error>
    func provision(
        _ device: ConnectedDevice,
        using provider: @escaping ProvisioningMaterialProvider
    ) async throws
    func deprovision(
        _ device: ConnectedDevice,
        grantBlob: String
    ) async throws -> DeprovisionResult
    func readConnectionSettings(from device: ConnectedDevice) async throws -> DeviceConnectionSettings
    func writeConnectionSettings(
        _ settings: DeviceConnectionSettings,
        to device: ConnectedDevice
    ) async throws
    func factoryReset(
        _ device: ConnectedDevice,
        commandID: String,
        bindingGeneration: UInt64,
        using provider: @escaping FactoryResetGrantProvider
    ) async throws -> FactoryResetCompletion
    func resumePendingFactoryReset(
        _ device: ConnectedDevice,
        currentBindingGeneration: UInt64
    ) async throws -> FactoryResetCompletion?
    func cancelCurrentOperation() async throws
    func cancelFactoryReset() async throws
}

struct BotaDeviceSDKSharedAppleSecurityClient: BotaDeviceSDKAppleSecurityClient {
    private let controls: DeviceControlManager
    private let provisioning: ProvisioningManager
    private let factoryResetManager: FactoryResetManager

    init(client: BotaDeviceClient = .shared) {
        controls = client.controls
        provisioning = client.provisioning
        factoryResetManager = client.factoryReset
    }

    func isProvisioned(_ device: ConnectedDevice) async throws -> Bool {
        try await controls.isProvisioned(device)
    }

    func readPublicKey(from device: ConnectedDevice) async throws -> String? {
        try await controls.readPublicKey(from: device)
    }

    func readAuthNonce(from device: ConnectedDevice) async throws -> String? {
        try await controls.readAuthNonce(from: device)
    }

    func setAPIEndpoint(_ environment: DeviceAPIEnvironment, on device: ConnectedDevice) async throws {
        try await controls.setAPIEndpoint(environment, on: device)
    }

    func deliverCertificate(
        _ certificatePEM: String,
        privateKeyPEM: String,
        to device: ConnectedDevice
    ) async throws {
        try await controls.deliverCertificate(
            certificatePEM,
            privateKeyPEM: privateKeyPEM,
            to: device
        )
    }

    func deliverBackendPublicKey(_ publicKey: Data, to device: ConnectedDevice) async throws {
        try await controls.deliverBackendPublicKey(publicKey, to: device)
    }

    func writeGrant(_ grantBlob: String, to device: ConnectedDevice) async throws {
        try await controls.writeGrant(grantBlob, to: device)
    }

    func syncTime(_ device: ConnectedDevice) async throws {
        try await controls.syncTime(to: device)
    }

    func requestStartRecording(
        _ device: ConnectedDevice,
        grantBlob: String
    ) async throws -> RecordingControlResult {
        try await controls.requestStartRecording(device, grantBlob: grantBlob)
    }

    func requestStopRecording(
        _ device: ConnectedDevice,
        grantBlob: String
    ) async throws -> RecordingControlResult {
        try await controls.requestStopRecording(device, grantBlob: grantBlob)
    }

    func readRecordingState(from device: ConnectedDevice) async throws -> RecordingState {
        try await controls.readRecordingState(from: device)
    }

    func recordingStateUpdates(
        _ device: ConnectedDevice
    ) async throws -> AsyncThrowingStream<RecordingState, Error> {
        try await controls.recordingStateUpdates(for: device)
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

    func deprovision(
        _ device: ConnectedDevice,
        grantBlob: String
    ) async throws -> DeprovisionResult {
        try await provisioning.deprovision(device, grantBlob: grantBlob)
    }

    func readConnectionSettings(from device: ConnectedDevice) async throws -> DeviceConnectionSettings {
        try await provisioning.readConnectionSettings(from: device)
    }

    func writeConnectionSettings(
        _ settings: DeviceConnectionSettings,
        to device: ConnectedDevice
    ) async throws {
        try await provisioning.writeConnectionSettings(settings, to: device)
    }

    func factoryReset(
        _ device: ConnectedDevice,
        commandID: String,
        bindingGeneration: UInt64,
        using provider: @escaping FactoryResetGrantProvider
    ) async throws -> FactoryResetCompletion {
        try await factoryResetManager.factoryReset(
            device,
            commandID: commandID,
            grantID: UUID().uuidString,
            bindingGeneration: bindingGeneration,
            using: provider
        )
    }

    func resumePendingFactoryReset(
        _ device: ConnectedDevice,
        currentBindingGeneration: UInt64
    ) async throws -> FactoryResetCompletion? {
        try await factoryResetManager.resumePendingFactoryReset(
            device,
            currentBindingGeneration: currentBindingGeneration
        )
    }

    func cancelCurrentOperation() async throws {
        try await provisioning.cancelCurrentOperation()
    }

    func cancelFactoryReset() async throws {
        try await factoryResetManager.cancelCurrentOperation()
    }
}

actor BotaDeviceSDKAppleSecurity {
    private enum MaterialError: LocalizedError {
        case cancelled
        case invalidFactoryResetGrant
        case rejected(String)
        case unknownRequest

        var errorDescription: String? {
            switch self {
            case .cancelled: "application material request was cancelled"
            case .invalidFactoryResetGrant: "factory reset grant is not valid encoded data"
            case let .rejected(message): message
            case .unknownRequest: "application material request is no longer pending"
            }
        }
    }

    private let client: any BotaDeviceSDKAppleSecurityClient
    private var provisioningRequests: [
        String: CheckedContinuation<ProvisioningMaterial, Error>
    ] = [:]
    private var factoryResetRequests: [String: CheckedContinuation<Data, Error>] = [:]
    private var recordingStateTask: Task<Void, Never>?

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

    func deprovision(
        _ device: ConnectedDevice,
        grantBlob: String
    ) async throws -> DeprovisionResult {
        try await client.deprovision(device, grantBlob: grantBlob)
    }

    func isProvisioned(_ device: ConnectedDevice) async throws -> Bool {
        try await client.isProvisioned(device)
    }

    func readPublicKey(from device: ConnectedDevice) async throws -> String? {
        try await client.readPublicKey(from: device)
    }

    func readAuthNonce(from device: ConnectedDevice) async throws -> String? {
        try await client.readAuthNonce(from: device)
    }

    func setAPIEndpoint(_ environment: DeviceAPIEnvironment, on device: ConnectedDevice) async throws {
        try await client.setAPIEndpoint(environment, on: device)
    }

    func deliverCertificate(
        _ certificatePEM: String,
        privateKeyPEM: String,
        to device: ConnectedDevice
    ) async throws {
        try await client.deliverCertificate(
            certificatePEM,
            privateKeyPEM: privateKeyPEM,
            to: device
        )
    }

    func deliverBackendPublicKey(_ publicKey: Data, to device: ConnectedDevice) async throws {
        try await client.deliverBackendPublicKey(publicKey, to: device)
    }

    func writeGrant(_ grantBlob: String, to device: ConnectedDevice) async throws {
        try await client.writeGrant(grantBlob, to: device)
    }

    func syncTime(_ device: ConnectedDevice) async throws {
        try await client.syncTime(device)
    }

    func requestStartRecording(
        _ device: ConnectedDevice,
        grantBlob: String
    ) async throws -> RecordingControlResult {
        try await client.requestStartRecording(device, grantBlob: grantBlob)
    }

    func requestStopRecording(
        _ device: ConnectedDevice,
        grantBlob: String
    ) async throws -> RecordingControlResult {
        try await client.requestStopRecording(device, grantBlob: grantBlob)
    }

    func readRecordingState(from device: ConnectedDevice) async throws -> RecordingState {
        try await client.readRecordingState(from: device)
    }

    func startRecordingStateUpdates(
        _ device: ConnectedDevice,
        onState: @escaping @Sendable (RecordingState) -> Void,
        onError: @escaping @Sendable (Error) -> Void = { _ in }
    ) async throws {
        await stopRecordingStateUpdates()
        let updates = try await client.recordingStateUpdates(device)
        let task = Task {
            do {
                for try await state in updates { onState(state) }
            } catch is CancellationError {
                // Explicit stop is not a recording-state stream failure.
            } catch {
                onError(error)
            }
        }
        recordingStateTask = task
    }

    func stopRecordingStateUpdates() async {
        guard let task = recordingStateTask else { return }
        recordingStateTask = nil
        task.cancel()
        await task.value
    }

    func readConnectionSettings(from device: ConnectedDevice) async throws -> DeviceConnectionSettings {
        try await client.readConnectionSettings(from: device)
    }

    func writeConnectionSettings(
        _ settings: DeviceConnectionSettings,
        to device: ConnectedDevice
    ) async throws {
        try await client.writeConnectionSettings(settings, to: device)
    }

    func factoryReset(
        _ device: ConnectedDevice,
        commandID: String,
        bindingGeneration: UInt64,
        onGrantRequest: @escaping @Sendable (BotaDeviceSDKAppleFactoryResetRequest) -> Void
    ) async throws -> FactoryResetCompletion {
        try await client.factoryReset(
            device,
            commandID: commandID,
            bindingGeneration: bindingGeneration
        ) { request in
            try await self.requestFactoryResetGrant(request, onRequest: onGrantRequest)
        }
    }

    func resumePendingFactoryReset(
        _ device: ConnectedDevice,
        currentBindingGeneration: UInt64
    ) async throws -> FactoryResetCompletion? {
        try await client.resumePendingFactoryReset(
            device,
            currentBindingGeneration: currentBindingGeneration
        )
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
        if let continuation = provisioningRequests.removeValue(forKey: requestID) {
            continuation.resume(throwing: MaterialError.rejected(message))
            return
        }
        if let continuation = factoryResetRequests.removeValue(forKey: requestID) {
            continuation.resume(throwing: MaterialError.rejected(message))
            return
        }
        throw MaterialError.unknownRequest
    }

    func resolveFactoryResetGrant(requestID: String, grantBlob: String) throws {
        guard let continuation = factoryResetRequests.removeValue(forKey: requestID) else {
            throw MaterialError.unknownRequest
        }
        guard let grant = Data(base64Encoded: grantBlob), !grant.isEmpty else {
            continuation.resume(throwing: MaterialError.invalidFactoryResetGrant)
            return
        }
        continuation.resume(returning: grant)
    }

    func cancelAll() async {
        await stopRecordingStateUpdates()
        let pending = provisioningRequests.values
        provisioningRequests.removeAll()
        pending.forEach { $0.resume(throwing: MaterialError.cancelled) }
        let pendingResets = factoryResetRequests.values
        factoryResetRequests.removeAll()
        pendingResets.forEach { $0.resume(throwing: MaterialError.cancelled) }
        try? await client.cancelCurrentOperation()
        try? await client.cancelFactoryReset()
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
        if let continuation = provisioningRequests.removeValue(forKey: requestID) {
            continuation.resume(throwing: MaterialError.cancelled)
        }
        if let continuation = factoryResetRequests.removeValue(forKey: requestID) {
            continuation.resume(throwing: MaterialError.cancelled)
        }
    }

    private func requestFactoryResetGrant(
        _ request: FactoryResetGrantRequest,
        onRequest: @escaping @Sendable (BotaDeviceSDKAppleFactoryResetRequest) -> Void
    ) async throws -> Data {
        let requestID = UUID().uuidString
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                factoryResetRequests[requestID] = continuation
                onRequest(.init(
                    requestID: requestID,
                    serialNumber: request.serialNumber,
                    nonce: request.nonce.hexString,
                    commandID: request.commandID,
                    bindingGeneration: request.bindingGeneration
                ))
            }
        } onCancel: {
            Task { await self.cancel(requestID: requestID) }
        }
    }
}

private extension Data {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
