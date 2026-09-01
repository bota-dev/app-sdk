import Foundation

public enum ProvisioningFailure: String, Equatable, Sendable {
    case invalidToken = "invalid_token"
    case storageError = "storage_error"
    case chunkError = "chunk_error"
    case alreadyPaired = "already_paired"
    case unknown
}

public struct DeprovisionResult: Equatable, Sendable {
    public let success: Bool
    public let error: ProvisioningFailure?

    public init(success: Bool, error: ProvisioningFailure? = nil) {
        self.success = success
        self.error = error
    }
}

public actor ProvisioningManager {
    private static let deprovisionCommandVariant: UInt8 = 1
    private static let deprovisionTimeoutNanoseconds: UInt64 = 30_000_000_000

    private var runtime: DeviceRuntime?
    private var activeCancellationID: UUID?

    public init() {}

    func attach(_ runtime: DeviceRuntime) { self.runtime = runtime }

    func detach() async {
        if let activeCancellationID {
            try? await runtime?.engine.cancel(activeCancellationID)
            await runtime?.operations.end(activeCancellationID)
        }
        activeCancellationID = nil
        runtime = nil
    }

    public func provision(
        _ device: ConnectedDevice,
        materialID: String,
        using provider: @escaping ProvisioningMaterialProvider
    ) async throws {
        let runtime = try configuredRuntime()
        try await runtime.connection.require(device)
        await runtime.registerProvisioning(materialID, provider)
        do {
            try await run(
                .provision(serialNumber: device.serialNumber, materialID: materialID),
                runtime: runtime
            )
            await runtime.unregisterMaterial(materialID)
        } catch {
            await runtime.unregisterMaterial(materialID)
            throw error
        }
    }

    public func writeConnectionSettings(
        _ settings: DeviceConnectionSettings,
        to device: ConnectedDevice
    ) async throws {
        let runtime = try configuredRuntime()
        try await runtime.connection.require(device)
        let operationID = UUID()
        try await runtime.operations.begin(operationID, operation: .encode)
        do {
            let data = try runtime.serializeConnectionSettings(settings, device.deviceType)
            try await runtime.directWrite(
                device.id,
                BotaBluetoothUUIDs.provisioningService,
                BotaBluetoothUUIDs.deviceSettings,
                data
            )
            await runtime.operations.end(operationID)
        } catch {
            await runtime.operations.end(operationID)
            throw error
        }
    }

    public func readConnectionSettings(
        from device: ConnectedDevice
    ) async throws -> DeviceConnectionSettings {
        let runtime = try configuredRuntime()
        try await runtime.connection.require(device)
        let operationID = UUID()
        try await runtime.operations.begin(operationID, operation: .decode)
        do {
            let data = try await runtime.directRead(
                device.id,
                BotaBluetoothUUIDs.provisioningService,
                BotaBluetoothUUIDs.deviceSettings
            )
            let settings = try runtime.parseConnectionSettings(data).settings
            await runtime.operations.end(operationID)
            return settings
        } catch {
            await runtime.operations.end(operationID)
            throw error
        }
    }

    public func deprovision(
        _ device: ConnectedDevice,
        grantBlob: String
    ) async throws -> DeprovisionResult {
        let runtime = try configuredRuntime()
        try await runtime.connection.require(device)
        guard let grant = Data(base64Encoded: grantBlob), !grant.isEmpty else {
            throw BotaSDKError(
                code: .invalidInput,
                operation: .validate,
                retryable: false,
                detail: "deprovision grant is not valid base64 data"
            )
        }
        let operationID = UUID()
        try await runtime.operations.begin(operationID, operation: .provision)
        do {
            try await runtime.directWrite(
                device.id,
                BotaBluetoothUUIDs.controlService,
                BotaBluetoothUUIDs.deviceCommand,
                grant
            )
            let source = try await runtime.directSubscribe(
                device.id,
                BotaBluetoothUUIDs.provisioningService,
                BotaBluetoothUUIDs.provisioningResult
            )
            let lease = ProvisioningResultSubscriptionLease(runtime: runtime, deviceID: device.id)
            let data = try runtime.encodeDeviceCommand(Self.deprovisionCommandVariant)
            do {
                try await runtime.directWrite(
                    device.id,
                    BotaBluetoothUUIDs.controlService,
                    BotaBluetoothUUIDs.deviceCommand,
                    data
                )
                let result = try await Self.awaitDeprovisionResult(source)
                await lease.close()
                await runtime.operations.end(operationID)
                return result
            } catch {
                await lease.close()
                throw error
            }
        } catch {
            await runtime.operations.end(operationID)
            throw error
        }
    }

    public func cancelCurrentOperation() async throws {
        guard let activeCancellationID else { return }
        let runtime = try configuredRuntime()
        try await runtime.engine.cancel(activeCancellationID)
        self.activeCancellationID = nil
        await runtime.operations.end(activeCancellationID)
    }

    private func run(_ command: CoreCommand, runtime: DeviceRuntime) async throws {
        guard activeCancellationID == nil else { throw operationInProgress() }
        try await runtime.operations.begin(command.cancellationID, operation: .provision)
        activeCancellationID = command.cancellationID
        do {
            try await awaitWorkflowCompletion(command, runtime: runtime)
            activeCancellationID = nil
            await runtime.operations.end(command.cancellationID)
        } catch {
            activeCancellationID = nil
            await runtime.operations.end(command.cancellationID)
            throw error
        }
    }

    private func configuredRuntime() throws -> DeviceRuntime {
        guard let runtime else {
            throw BotaSDKError(
                code: .featureUnavailable,
                operation: .validate,
                retryable: false,
                detail: "BotaDeviceClient.configure() must be called first"
            )
        }
        return runtime
    }

    private static func awaitDeprovisionResult(
        _ notifications: AsyncThrowingStream<Data, Error>
    ) async throws -> DeprovisionResult {
        try await withThrowingTaskGroup(of: DeprovisionResult.self) { group in
            group.addTask {
                for try await data in notifications {
                    return deprovisionResult(data.first)
                }
                throw BotaSDKError(
                    code: .unexpectedEvent,
                    operation: .provision,
                    retryable: true,
                    detail: "deprovision result subscription ended without a result"
                )
            }
            group.addTask {
                try await Task.sleep(nanoseconds: deprovisionTimeoutNanoseconds)
                throw BotaSDKError(
                    code: .timeout,
                    operation: .provision,
                    retryable: true,
                    detail: "deprovision timed out"
                )
            }
            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }

    private static func deprovisionResult(_ status: UInt8?) -> DeprovisionResult {
        switch status {
        case 0: DeprovisionResult(success: true)
        case 1: DeprovisionResult(success: false, error: .invalidToken)
        case 2: DeprovisionResult(success: false, error: .storageError)
        case 3: DeprovisionResult(success: false, error: .chunkError)
        case 4: DeprovisionResult(success: false, error: .alreadyPaired)
        default: DeprovisionResult(success: false, error: .unknown)
        }
    }

    private func operationInProgress() -> BotaSDKError {
        BotaSDKError(
            code: .operationInProgress,
            operation: .provision,
            retryable: false,
            detail: "another provisioning workflow is already active"
        )
    }
}

private actor ProvisioningResultSubscriptionLease {
    private let runtime: DeviceRuntime
    private let deviceID: String
    private var closed = false

    init(runtime: DeviceRuntime, deviceID: String) {
        self.runtime = runtime
        self.deviceID = deviceID
    }

    func close() async {
        guard !closed else { return }
        closed = true
        try? await runtime.directUnsubscribe(
            deviceID,
            BotaBluetoothUUIDs.provisioningService,
            BotaBluetoothUUIDs.provisioningResult
        )
    }
}
