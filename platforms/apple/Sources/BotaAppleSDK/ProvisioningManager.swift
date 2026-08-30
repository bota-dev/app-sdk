import Foundation

public actor ProvisioningManager {
    private static let deprovisionCommandVariant: UInt8 = 1

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

    public func deprovision(_ device: ConnectedDevice) async throws {
        let runtime = try configuredRuntime()
        try await runtime.connection.require(device)
        let operationID = UUID()
        try await runtime.operations.begin(operationID, operation: .provision)
        do {
            let data = try runtime.encodeDeviceCommand(Self.deprovisionCommandVariant)
            try await runtime.directWrite(
                device.id,
                BotaBluetoothUUIDs.controlService,
                BotaBluetoothUUIDs.deviceCommand,
                data
            )
            await runtime.operations.end(operationID)
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

    private func operationInProgress() -> BotaSDKError {
        BotaSDKError(
            code: .operationInProgress,
            operation: .provision,
            retryable: false,
            detail: "another provisioning workflow is already active"
        )
    }
}
