import Foundation

public struct FactoryResetGrantRequest: Sendable {
    public let serialNumber: String
    public let nonce: Data
    public let commandID: String
    public let bindingGeneration: UInt64

    public init(serialNumber: String, nonce: Data, commandID: String, bindingGeneration: UInt64) {
        self.serialNumber = serialNumber
        self.nonce = nonce
        self.commandID = commandID
        self.bindingGeneration = bindingGeneration
    }
}

public typealias FactoryResetGrantProvider = @Sendable (FactoryResetGrantRequest) async throws -> Data

public struct FactoryResetPersistenceResult: Equatable, Sendable {
    public let localRecordingsDeleted: UInt16

    public init(localRecordingsDeleted: UInt16) {
        self.localRecordingsDeleted = localRecordingsDeleted
    }
}

public typealias FactoryResetResultPersister = @Sendable (
    FactoryResetPersistenceResult
) async throws -> Void

public struct FactoryResetCompletion: Equatable, Sendable {
    public let commandID: String
    public let bindingGeneration: UInt64

    public init(commandID: String, bindingGeneration: UInt64) {
        self.commandID = commandID
        self.bindingGeneration = bindingGeneration
    }
}

public actor FactoryResetManager {
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

    public func factoryReset(
        _ device: ConnectedDevice,
        commandID: String,
        grantID: String,
        bindingGeneration: UInt64,
        persistResult: FactoryResetResultPersister? = nil,
        using provider: @escaping FactoryResetGrantProvider
    ) async throws -> FactoryResetCompletion {
        let runtime = try configuredRuntime()
        try await runtime.connection.require(device)
        await runtime.registerFactoryResetGeneration(commandID, bindingGeneration)
        if let persistResult {
            await runtime.registerFactoryResetResultPersister(commandID) { result in
                try await persistResult(try Self.persistenceResult(result))
            }
        }
        await runtime.registerFactoryReset(grantID) { request in
            try await provider(.init(
                serialNumber: request.serialNumber,
                nonce: request.nonce,
                commandID: commandID,
                bindingGeneration: bindingGeneration
            ))
        }
        do {
            try await run(
                .factoryReset(
                    serialNumber: device.serialNumber,
                    commandID: commandID,
                    grantID: grantID
                ),
                runtime: runtime
            )
            await cleanup(commandID: commandID, grantID: grantID, runtime: runtime)
            return FactoryResetCompletion(
                commandID: commandID,
                bindingGeneration: bindingGeneration
            )
        } catch {
            await cleanup(commandID: commandID, grantID: grantID, runtime: runtime)
            throw error
        }
    }

    public func resumePendingFactoryReset(
        _ device: ConnectedDevice,
        currentBindingGeneration: UInt64,
        persistResult: FactoryResetResultPersister? = nil
    ) async throws -> FactoryResetCompletion? {
        let runtime = try configuredRuntime()
        try await runtime.connection.require(device)
        guard let saved = try await runtime.loadPendingFactoryReset() else { return nil }
        guard saved.bindingGeneration == currentBindingGeneration else {
            throw BotaSDKError(
                code: .identityMismatch,
                operation: .factoryReset,
                retryable: false,
                detail: "pending factory reset belongs to a different binding generation"
            )
        }
        guard let resultCode = UInt8(exactly: saved.resultCode),
              let deletedCount = UInt16(exactly: saved.deletedRecordingCount)
        else {
            throw BotaSDKError(
                code: .persistenceFailed,
                operation: .factoryReset,
                retryable: false,
                detail: "pending factory-reset result is out of range"
            )
        }
        await runtime.registerFactoryResetGeneration(saved.commandID, currentBindingGeneration)
        if let persistResult {
            await runtime.registerFactoryResetResultPersister(saved.commandID) { result in
                try await persistResult(try Self.persistenceResult(result))
            }
        }
        do {
            try await run(
                .resumeFactoryReset(
                    serialNumber: device.serialNumber,
                    commandID: saved.commandID,
                    resultCode: resultCode,
                    deletedRecordingCount: deletedCount
                ),
                runtime: runtime
            )
            await cleanup(commandID: saved.commandID, grantID: nil, runtime: runtime)
            return FactoryResetCompletion(
                commandID: saved.commandID,
                bindingGeneration: currentBindingGeneration
            )
        } catch {
            await cleanup(commandID: saved.commandID, grantID: nil, runtime: runtime)
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
        guard activeCancellationID == nil else {
            throw BotaSDKError(
                code: .operationInProgress,
                operation: .factoryReset,
                retryable: false,
                detail: "another factory-reset workflow is already active"
            )
        }
        try await runtime.operations.begin(command.cancellationID, operation: .factoryReset)
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

    private func cleanup(commandID: String, grantID: String?, runtime: DeviceRuntime) async {
        if let grantID { await runtime.unregisterMaterial(grantID) }
        await runtime.unregisterFactoryResetResultPersister(commandID)
        await runtime.unregisterFactoryResetGeneration(commandID)
    }

    private static func persistenceResult(
        _ result: PersistedFactoryResetResult
    ) throws -> FactoryResetPersistenceResult {
        guard result.resultCode == 0,
              let deleted = UInt16(exactly: result.deletedRecordingCount)
        else {
            throw BotaSDKError(
                code: .persistenceFailed,
                operation: .factoryReset,
                retryable: false,
                detail: "factory-reset persistence result is out of range"
            )
        }
        return .init(localRecordingsDeleted: deleted)
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
}
