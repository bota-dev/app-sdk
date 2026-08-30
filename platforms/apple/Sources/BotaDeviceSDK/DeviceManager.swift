import BotaDeviceSDKC
import Foundation

public struct DeviceCapabilities: OptionSet, Equatable, Sendable {
    public let rawValue: UInt64

    public static let bluetooth = Self(rawValue: 1 << 0)
    public static let persistence = Self(rawValue: 1 << 1)
    public static let secureStorage = Self(rawValue: 1 << 2)
    public static let networkTransfer = Self(rawValue: 1 << 3)
    public static let recordingSink = Self(rawValue: 1 << 4)
    public static let firmwareBlob = Self(rawValue: 1 << 5)

    public init(rawValue: UInt64) { self.rawValue = rawValue }

    init(core: CoreCapabilities) {
        var value: Self = []
        if core.contains(.bluetooth) { value.insert(.bluetooth) }
        if core.contains(.persistence) { value.insert(.persistence) }
        if core.contains(.secureStorage) { value.insert(.secureStorage) }
        if core.contains(.networkTransfer) { value.insert(.networkTransfer) }
        if core.contains(.recordingSink) { value.insert(.recordingSink) }
        if core.contains(.firmwareBlob) { value.insert(.firmwareBlob) }
        self = value
    }
}

public struct DeviceReconnectHint: Equatable, Sendable {
    public var storedPeripheralID: String?
    public var advertisedAddress: String?
    public var storedName: String?
    public var scanTimeoutMilliseconds: UInt64
    public var connectionTimeoutMilliseconds: UInt64

    public init(
        storedPeripheralID: String? = nil,
        advertisedAddress: String? = nil,
        storedName: String? = nil,
        scanTimeoutMilliseconds: UInt64 = 10_000,
        connectionTimeoutMilliseconds: UInt64 = 10_000
    ) {
        self.storedPeripheralID = storedPeripheralID
        self.advertisedAddress = advertisedAddress
        self.storedName = storedName
        self.scanTimeoutMilliseconds = scanTimeoutMilliseconds
        self.connectionTimeoutMilliseconds = connectionTimeoutMilliseconds
    }
}

protocol CoreWorkflowRunning: Sendable {
    func run(
        _ command: CoreCommand,
        capabilities: CoreCapabilities
    ) async -> AsyncThrowingStream<CoreNotification, Error>
    func cancel(_ id: UUID) async throws
}

extension CoreEngineActor: CoreWorkflowRunning {}

struct DeviceRuntime: Sendable {
    let engine: any CoreWorkflowRunning
    let capabilities: CoreCapabilities
    let connection: DeviceConnectionRegistry
    let operations: DeviceOperationCoordinator
    let disconnect: @Sendable (String) async throws -> Void
    let readStatus: @Sendable (String) async throws -> DeviceStatus
    let statusUpdates: @Sendable (String) async throws -> AsyncThrowingStream<DeviceStatus, Error>
    let stopStatusUpdates: @Sendable (String) async throws -> Void
    let directWrite: @Sendable (String, String, String, Data) async throws -> Void
    let serializeConnectionSettings: @Sendable (DeviceConnectionSettings, DeviceType) throws -> Data
    let encodeDeviceCommand: @Sendable (UInt8) throws -> Data
    let registerProvisioning: @Sendable (String, @escaping ProvisioningMaterialProvider) async -> Void
    let registerFactoryReset: @Sendable (String, @escaping FactoryResetMaterialProvider) async -> Void
    let unregisterMaterial: @Sendable (String) async -> Void
    let registerFactoryResetGeneration: @Sendable (String, UInt64) async -> Void
    let unregisterFactoryResetGeneration: @Sendable (String) async -> Void
    let loadPendingFactoryReset: @Sendable () async throws -> PersistedFactoryResetResult?

    init(
        engine: any CoreWorkflowRunning,
        capabilities: CoreCapabilities,
        connection: DeviceConnectionRegistry = DeviceConnectionRegistry(),
        operations: DeviceOperationCoordinator = DeviceOperationCoordinator(),
        disconnect: @escaping @Sendable (String) async throws -> Void,
        readStatus: @escaping @Sendable (String) async throws -> DeviceStatus = { _ in
            throw NativeHostError.missingResource("device status")
        },
        statusUpdates: @escaping @Sendable (String) async throws -> AsyncThrowingStream<DeviceStatus, Error> = { _ in
            throw NativeHostError.missingResource("device status subscription")
        },
        stopStatusUpdates: @escaping @Sendable (String) async throws -> Void = { _ in },
        directWrite: @escaping @Sendable (String, String, String, Data) async throws -> Void = { _, _, _, _ in
            throw NativeHostError.missingResource("direct device write")
        },
        serializeConnectionSettings: @escaping @Sendable (DeviceConnectionSettings, DeviceType) throws -> Data = { _, _ in
            throw NativeHostError.missingResource("connection-settings encoder")
        },
        encodeDeviceCommand: @escaping @Sendable (UInt8) throws -> Data = { _ in
            throw NativeHostError.missingResource("device-command encoder")
        },
        registerProvisioning: @escaping @Sendable (String, @escaping ProvisioningMaterialProvider) async -> Void = { _, _ in },
        registerFactoryReset: @escaping @Sendable (String, @escaping FactoryResetMaterialProvider) async -> Void = { _, _ in },
        unregisterMaterial: @escaping @Sendable (String) async -> Void = { _ in },
        registerFactoryResetGeneration: @escaping @Sendable (String, UInt64) async -> Void = { _, _ in },
        unregisterFactoryResetGeneration: @escaping @Sendable (String) async -> Void = { _ in },
        loadPendingFactoryReset: @escaping @Sendable () async throws -> PersistedFactoryResetResult? = { nil }
    ) {
        self.engine = engine
        self.capabilities = capabilities
        self.connection = connection
        self.operations = operations
        self.disconnect = disconnect
        self.readStatus = readStatus
        self.statusUpdates = statusUpdates
        self.stopStatusUpdates = stopStatusUpdates
        self.directWrite = directWrite
        self.serializeConnectionSettings = serializeConnectionSettings
        self.encodeDeviceCommand = encodeDeviceCommand
        self.registerProvisioning = registerProvisioning
        self.registerFactoryReset = registerFactoryReset
        self.unregisterMaterial = unregisterMaterial
        self.registerFactoryResetGeneration = registerFactoryResetGeneration
        self.unregisterFactoryResetGeneration = unregisterFactoryResetGeneration
        self.loadPendingFactoryReset = loadPendingFactoryReset
    }
}

extension CoreCapabilities {
    static let all: Self = [
        .bluetooth, .timer, .persistence, .secureStorage, .networkTransfer,
        .progress, .hostMaterial, .recordingSink, .firmwareBlob,
    ]
}

public actor DeviceManager {
    private struct ActiveOperation {
        let cancellationID: UUID
        var task: Task<Void, Never>?
    }

    private struct StatusObserver {
        let peripheralID: String
        let continuation: AsyncThrowingStream<DeviceStatus, Error>.Continuation
        var task: Task<Void, Never>?
    }

    private var runtime: DeviceRuntime?
    private var activeOperation: ActiveOperation?
    private var connectedDevice: ConnectedDevice?
    private var connectionObservers: [UUID: AsyncStream<ConnectedDevice?>.Continuation] = [:]
    private var statusObservers: [UUID: StatusObserver] = [:]

    public init() {}

    func attach(_ runtime: DeviceRuntime) {
        self.runtime = runtime
    }

    func detach() async {
        if let activeOperation {
            activeOperation.task?.cancel()
            try? await runtime?.engine.cancel(activeOperation.cancellationID)
            await runtime?.operations.end(activeOperation.cancellationID)
        }
        await stopAllStatusObservers()
        if let connectedDevice { try? await runtime?.disconnect(connectedDevice.id) }
        await runtime?.connection.clear()
        activeOperation = nil
        connectedDevice = nil
        runtime = nil
        connectionObservers.values.forEach { $0.finish() }
        connectionObservers.removeAll()
    }

    public func capabilities() throws -> DeviceCapabilities {
        DeviceCapabilities(core: try configuredRuntime().capabilities)
    }

    public func startScan(
        timeoutMilliseconds: UInt64 = 10_000,
        allowDuplicates: Bool = false
    ) async throws -> AsyncThrowingStream<DiscoveredDevice, Error> {
        let runtime = try await beginOperation(operation: .discover)
        let cancellationID = activeOperation!.cancellationID
        let command = CoreCommand.discoverDevices(
            timeoutMilliseconds: timeoutMilliseconds,
            allowDuplicates: allowDuplicates,
            cancellationID: cancellationID
        )
        let pair = AsyncThrowingStream<DiscoveredDevice, Error>.makeStream()
        let task = Task {
            do {
                let notifications = await runtime.engine.run(command, capabilities: runtime.capabilities)
                for try await notification in notifications {
                    switch notification.kind {
                    case .deviceDiscovered:
                        pair.continuation.yield(try Self.discoveredDevice(notification))
                    case .failed:
                        throw Self.publicError(notification)
                    case .started, .connectionEstablished, .progress, .retrying,
                         .deviceUploadPreserved, .bleFallbackReady, .firmwareProgress,
                         .deviceLog, .completed, .cancelled:
                        break
                    }
                }
                pair.continuation.finish()
            } catch is CancellationError {
                pair.continuation.finish()
            } catch {
                pair.continuation.finish(throwing: Self.publicError(error))
            }
            await finishOperation(cancellationID)
        }
        activeOperation?.task = task
        pair.continuation.onTermination = { @Sendable _ in
            Task { await self.cancelIfActive(cancellationID) }
        }
        return pair.stream
    }

    public func connect(serialNumber: String, device: DiscoveredDevice) async throws -> ConnectedDevice {
        if let connectedDevice, connectedDevice.id != device.id {
            let runtime = try configuredRuntime()
            await stopAllStatusObservers()
            try await runtime.disconnect(connectedDevice.id)
            await runtime.connection.clear()
            self.connectedDevice = nil
            publishConnection()
        }
        return try await runConnection(
            .connect(
                serialNumber: serialNumber,
                peripheralID: device.id,
                name: device.name,
                advertisedAddress: device.macAddress,
                rssi: Int16(clamping: device.rssi)
            ),
            source: device
        )
    }

    public func reconnect(
        serialNumber: String,
        hint: DeviceReconnectHint = .init()
    ) async throws -> ConnectedDevice {
        try await runConnection(
            .reconnect(
                serialNumber: serialNumber,
                storedPeripheralID: hint.storedPeripheralID,
                advertisedAddress: hint.advertisedAddress,
                storedName: hint.storedName,
                scanTimeoutMilliseconds: hint.scanTimeoutMilliseconds,
                connectionTimeoutMilliseconds: hint.connectionTimeoutMilliseconds
            ),
            source: nil
        )
    }

    public func disconnect() async throws {
        guard let connectedDevice else { return }
        let runtime = try configuredRuntime()
        await stopAllStatusObservers()
        try await runtime.disconnect(connectedDevice.id)
        await runtime.connection.clear()
        self.connectedDevice = nil
        publishConnection()
    }

    public func cancelCurrentOperation() async throws {
        guard let activeOperation else { return }
        let runtime = try configuredRuntime()
        activeOperation.task?.cancel()
        try await runtime.engine.cancel(activeOperation.cancellationID)
        self.activeOperation = nil
        await runtime.operations.end(activeOperation.cancellationID)
    }

    public func connectionUpdates() -> AsyncStream<ConnectedDevice?> {
        let id = UUID()
        let pair = AsyncStream<ConnectedDevice?>.makeStream()
        connectionObservers[id] = pair.continuation
        pair.continuation.yield(connectedDevice)
        pair.continuation.onTermination = { @Sendable _ in
            Task { await self.removeConnectionObserver(id) }
        }
        return pair.stream
    }

    public func readStatus() async throws -> DeviceStatus {
        guard let connectedDevice else {
            throw BotaDeviceSDKError(
                code: .notConnected,
                operation: .readStatus,
                retryable: true,
                detail: "a verified device connection is required"
            )
        }
        return try await configuredRuntime().readStatus(connectedDevice.id)
    }

    public func statusUpdates() throws -> AsyncThrowingStream<DeviceStatus, Error> {
        guard let connectedDevice else {
            throw BotaDeviceSDKError(
                code: .notConnected,
                operation: .readStatus,
                retryable: true,
                detail: "a verified device connection is required"
            )
        }
        let runtime = try configuredRuntime()
        let id = UUID()
        let pair = AsyncThrowingStream<DeviceStatus, Error>.makeStream()
        statusObservers[id] = StatusObserver(
            peripheralID: connectedDevice.id,
            continuation: pair.continuation,
            task: nil
        )
        let task = Task {
            do {
                let updates = try await runtime.statusUpdates(connectedDevice.id)
                for try await status in updates { pair.continuation.yield(status) }
                pair.continuation.finish()
            } catch is CancellationError {
                pair.continuation.finish()
            } catch {
                pair.continuation.finish(throwing: Self.publicError(error))
            }
            statusObserverCompleted(id)
        }
        statusObservers[id]?.task = task
        pair.continuation.onTermination = { @Sendable _ in Task { await self.stopStatusObserver(id) } }
        return pair.stream
    }

    private func runConnection(_ command: CoreCommand, source: DiscoveredDevice?) async throws -> ConnectedDevice {
        let runtime = try await beginOperation(
            cancellationID: command.cancellationID,
            operation: command.kind == UInt32(BOTA_DEVICE_SDK_V1_COMMAND_RECONNECT) ? .reconnect : .connect
        )
        var established: ConnectedDevice?
        do {
            let notifications = await runtime.engine.run(command, capabilities: runtime.capabilities)
            for try await notification in notifications {
                switch notification.kind {
                case .connectionEstablished:
                    established = try Self.connectedDevice(notification, source: source)
                case .failed:
                    throw Self.publicError(notification)
                case .started, .deviceDiscovered, .progress, .retrying,
                     .deviceUploadPreserved, .bleFallbackReady, .firmwareProgress,
                     .deviceLog, .completed, .cancelled:
                    break
                }
            }
        } catch {
            await finishOperation(command.cancellationID)
            throw Self.publicError(error)
        }
        guard let established else {
            await finishOperation(command.cancellationID)
            throw BotaDeviceSDKError(
                code: .connectionFailed,
                operation: command.kind == UInt32(BOTA_DEVICE_SDK_V1_COMMAND_RECONNECT) ? .reconnect : .connect,
                retryable: true,
                detail: "connection completed without verified identity"
            )
        }
        connectedDevice = established
        await runtime.connection.set(established)
        publishConnection()
        await finishOperation(command.cancellationID)
        return established
    }

    private func configuredRuntime() throws -> DeviceRuntime {
        guard let runtime else {
            throw BotaDeviceSDKError(
                code: .featureUnavailable,
                operation: .validate,
                retryable: false,
                detail: "BotaDeviceClient.configure() must be called first"
            )
        }
        return runtime
    }

    private func beginOperation(
        cancellationID: UUID = UUID(),
        operation: BotaOperation
    ) async throws -> DeviceRuntime {
        let runtime = try configuredRuntime()
        guard activeOperation == nil else {
            throw BotaDeviceSDKError(
                code: .operationInProgress,
                operation: .validate,
                retryable: false,
                detail: "another device workflow is already active"
            )
        }
        try await runtime.operations.begin(cancellationID, operation: operation)
        activeOperation = ActiveOperation(cancellationID: cancellationID)
        return runtime
    }

    private func finishOperation(_ cancellationID: UUID) async {
        if activeOperation?.cancellationID == cancellationID {
            activeOperation = nil
            await runtime?.operations.end(cancellationID)
        }
    }

    private func cancelIfActive(_ cancellationID: UUID) async {
        guard activeOperation?.cancellationID == cancellationID else { return }
        activeOperation?.task?.cancel()
        try? await runtime?.engine.cancel(cancellationID)
        activeOperation = nil
        await runtime?.operations.end(cancellationID)
    }

    private func publishConnection() {
        connectionObservers.values.forEach { $0.yield(connectedDevice) }
    }

    private func removeConnectionObserver(_ id: UUID) { connectionObservers[id] = nil }
    private func statusObserverCompleted(_ id: UUID) { statusObservers[id] = nil }

    private func stopStatusObserver(_ id: UUID) async {
        guard let observer = statusObservers.removeValue(forKey: id) else { return }
        observer.task?.cancel()
        observer.continuation.finish()
        try? await runtime?.stopStatusUpdates(observer.peripheralID)
    }

    private func stopAllStatusObservers() async {
        let observers = statusObservers
        statusObservers.removeAll()
        for observer in observers.values {
            observer.task?.cancel()
            observer.continuation.finish()
            try? await runtime?.stopStatusUpdates(observer.peripheralID)
        }
    }

    private static func discoveredDevice(_ notification: CoreNotification) throws -> DiscoveredDevice {
        DiscoveredDevice(
            id: try text(notification, UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID)),
            name: optionalText(notification, UInt32(BOTA_DEVICE_SDK_V1_FIELD_NAME)),
            macAddress: optionalText(notification, UInt32(BOTA_DEVICE_SDK_V1_FIELD_ADVERTISED_ADDRESS)),
            rssi: Int(try signed(notification, UInt32(BOTA_DEVICE_SDK_V1_FIELD_RSSI)))
        )
    }

    private static func connectedDevice(
        _ notification: CoreNotification,
        source: DiscoveredDevice?
    ) throws -> ConnectedDevice {
        ConnectedDevice(
            id: try text(notification, UInt32(BOTA_DEVICE_SDK_V1_FIELD_PERIPHERAL_ID)),
            serialNumber: try text(notification, UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER)),
            deviceType: source?.deviceType ?? .unknown(0),
            firmwareVersion: source?.firmwareVersion ?? "",
            isProvisioned: false,
            connectionState: .connected,
            mtu: 0
        )
    }

    private static func publicError(_ notification: CoreNotification) -> BotaDeviceSDKError {
        let errorCode = notification.packet.fields.unsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_ERROR_CODE)) ?? 21
        return BotaDeviceSDKError(
            code: BotaDeviceSDKError.code(UInt32(clamping: errorCode)),
            operation: BotaDeviceSDKError.operation(notification.packet.operation),
            retryable: notification.packet.fields.bool(UInt32(BOTA_DEVICE_SDK_V1_FIELD_RETRYABLE)) ?? false,
            protocolStatus: notification.packet.fields
                .unsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_PROTOCOL_STATUS))
                .flatMap(UInt16.init(exactly:)),
            detail: optionalText(notification, UInt32(BOTA_DEVICE_SDK_V1_FIELD_ERROR_DETAIL)) ?? "device workflow failed"
        )
    }

    private static func publicError(_ error: Error) -> Error {
        if let error = error as? BotaDeviceSDKError { return error }
        if let error = error as? CoreError { return BotaDeviceSDKError(error) }
        return error
    }

    private static func text(_ notification: CoreNotification, _ id: UInt32) throws -> String {
        guard let value = optionalText(notification, id) else { throw NativeHostError.missingField(id) }
        return value
    }

    private static func optionalText(_ notification: CoreNotification, _ id: UInt32) -> String? {
        notification.packet.fields.text(id)
    }

    private static func signed(_ notification: CoreNotification, _ id: UInt32) throws -> Int64 {
        for field in notification.packet.fields {
            if case let .signed(fieldID, value) = field, fieldID == id { return value }
        }
        throw NativeHostError.missingField(id)
    }
}

private extension Array where Element == CoreField {
    func bool(_ id: UInt32) -> Bool? {
        for field in self {
            if case let .bool(fieldID, value) = field, fieldID == id { return value }
        }
        return nil
    }

    func text(_ id: UInt32) -> String? {
        for field in self {
            if case let .text(fieldID, value) = field, fieldID == id { return value }
        }
        return nil
    }
}
