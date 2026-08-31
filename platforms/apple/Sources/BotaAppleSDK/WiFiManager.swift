import Foundation

public actor WiFiManager {
    private struct ActiveOperation {
        let id: UUID
        let cancel: @Sendable () -> Void
        let wait: @Sendable () async -> Void
    }

    private struct StatusObserver {
        let continuation: AsyncThrowingStream<WiFiStatusInfo, Error>.Continuation
        let lease: WiFiSubscriptionLease
        var task: Task<Void, Never>?
    }

    private static let operationTimeoutNanoseconds: UInt64 = 30_000_000_000

    private var runtime: DeviceRuntime?
    private var activeOperation: ActiveOperation?
    private var statusObservers: [UUID: StatusObserver] = [:]

    public init() {}

    func attach(_ runtime: DeviceRuntime) { self.runtime = runtime }

    func detach() async {
        let configured = runtime
        if let operation = activeOperation {
            operation.cancel()
            await operation.wait()
            await configured?.operations.end(operation.id)
            activeOperation = nil
        }
        await stopAllStatusObservers()
        runtime = nil
    }

    public func configure(
        _ device: ConnectedDevice,
        ssid: String,
        password: String,
        grantBlob: String
    ) async throws -> WiFiConfigResult {
        try await performOperation(device, operation: .provision) { runtime in
            let grant = try runtime.createWiFiGrantPacket(grantBlob)
            let credentials = try runtime.createWiFiCredentialPacket(ssid, password)
            try await runtime.directWrite(
                device.id,
                BotaBluetoothUUIDs.wifiService,
                BotaBluetoothUUIDs.wifiGrant,
                grant
            )
            return try await Self.withSubscription(
                runtime: runtime,
                deviceID: device.id,
                characteristicUUID: BotaBluetoothUUIDs.wifiStatus
            ) { notifications in
                try await runtime.directWrite(
                    device.id,
                    BotaBluetoothUUIDs.wifiService,
                    BotaBluetoothUUIDs.wifiCredential,
                    credentials
                )
                return try await Self.awaitConfigResult(notifications, runtime: runtime)
            }
        }
    }

    public func disconnect(_ device: ConnectedDevice) async throws -> WiFiConfigResult {
        try await performOperation(device, operation: .provision) { runtime in
            let command = try runtime.createWiFiCredentialPacket("", "")
            return try await Self.withSubscription(
                runtime: runtime,
                deviceID: device.id,
                characteristicUUID: BotaBluetoothUUIDs.wifiStatus
            ) { notifications in
                try await runtime.directWrite(
                    device.id,
                    BotaBluetoothUUIDs.wifiService,
                    BotaBluetoothUUIDs.wifiCredential,
                    command
                )
                return try await Self.awaitConfigResult(notifications, runtime: runtime)
            }
        }
    }

    public func readStatus(_ device: ConnectedDevice) async throws -> WiFiStatusInfo {
        try await performOperation(device, operation: .readStatus) { runtime in
            let data = try await runtime.directRead(
                device.id,
                BotaBluetoothUUIDs.wifiService,
                BotaBluetoothUUIDs.wifiStatus
            )
            return try runtime.parseWiFiStatusInfo(data)
        }
    }

    public func statusUpdates(
        _ device: ConnectedDevice
    ) async throws -> AsyncThrowingStream<WiFiStatusInfo, Error> {
        let runtime = try configuredRuntime()
        try await runtime.connection.require(device)
        let source = try await runtime.directSubscribe(
            device.id,
            BotaBluetoothUUIDs.wifiService,
            BotaBluetoothUUIDs.wifiStatus
        )
        let lease = WiFiSubscriptionLease(
            runtime: runtime,
            deviceID: device.id,
            characteristicUUID: BotaBluetoothUUIDs.wifiStatus
        )
        let id = UUID()
        let pair = AsyncThrowingStream<WiFiStatusInfo, Error>.makeStream()
        statusObservers[id] = StatusObserver(continuation: pair.continuation, lease: lease, task: nil)
        let task = Task {
            do {
                for try await data in source {
                    pair.continuation.yield(try runtime.parseWiFiStatusInfo(data))
                }
                pair.continuation.finish()
            } catch is CancellationError {
                pair.continuation.finish()
            } catch {
                pair.continuation.finish(throwing: error)
            }
            await self.completeStatusObserver(id)
        }
        statusObservers[id]?.task = task
        pair.continuation.onTermination = { @Sendable _ in
            Task { await self.stopStatusObserver(id) }
        }
        return pair.stream
    }

    public func scanNetworks(_ device: ConnectedDevice) async throws -> DeviceWiFiScanResult {
        try await performOperation(device, operation: .readStatus) { runtime in
            let command = try runtime.createWiFiScanCommand()
            return try await Self.withSubscription(
                runtime: runtime,
                deviceID: device.id,
                characteristicUUID: BotaBluetoothUUIDs.wifiScan
            ) { notifications in
                try await runtime.directWrite(
                    device.id,
                    BotaBluetoothUUIDs.wifiService,
                    BotaBluetoothUUIDs.wifiScan,
                    command
                )
                return try await Self.awaitScanResult(notifications, runtime: runtime)
            }
        }
    }

    public func cancelCurrentOperation() async {
        guard let operation = activeOperation else { return }
        operation.cancel()
        await operation.wait()
        await finishOperation(operation.id, runtime: runtime)
    }

    private func performOperation<T: Sendable>(
        _ device: ConnectedDevice,
        operation: BotaOperation,
        body: @escaping @Sendable (DeviceRuntime) async throws -> T
    ) async throws -> T {
        let runtime = try configuredRuntime()
        try await runtime.connection.require(device)
        let id = UUID()
        try await runtime.operations.begin(id, operation: operation)
        let task = Task { try await body(runtime) }
        activeOperation = ActiveOperation(
            id: id,
            cancel: { task.cancel() },
            wait: { _ = try? await task.value }
        )
        do {
            let value = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
            await finishOperation(id, runtime: runtime)
            return value
        } catch is CancellationError {
            await finishOperation(id, runtime: runtime)
            throw Self.cancelled(operation)
        } catch {
            await finishOperation(id, runtime: runtime)
            throw error
        }
    }

    private func finishOperation(_ id: UUID, runtime: DeviceRuntime?) async {
        if activeOperation?.id == id { activeOperation = nil }
        await runtime?.operations.end(id)
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

    private func completeStatusObserver(_ id: UUID) async {
        guard let observer = statusObservers.removeValue(forKey: id) else { return }
        await observer.lease.close()
    }

    private func stopStatusObserver(_ id: UUID) async {
        guard let observer = statusObservers.removeValue(forKey: id) else { return }
        observer.task?.cancel()
        observer.continuation.finish()
        await observer.lease.close()
    }

    private func stopAllStatusObservers() async {
        let observers = statusObservers
        statusObservers.removeAll()
        for observer in observers.values {
            observer.task?.cancel()
            observer.continuation.finish()
            await observer.lease.close()
        }
    }

    private static func withSubscription<T: Sendable>(
        runtime: DeviceRuntime,
        deviceID: String,
        characteristicUUID: String,
        body: @escaping @Sendable (AsyncThrowingStream<Data, Error>) async throws -> T
    ) async throws -> T {
        let source = try await runtime.directSubscribe(
            deviceID,
            BotaBluetoothUUIDs.wifiService,
            characteristicUUID
        )
        let lease = WiFiSubscriptionLease(
            runtime: runtime,
            deviceID: deviceID,
            characteristicUUID: characteristicUUID
        )
        return try await withTaskCancellationHandler {
            do {
                let value = try await body(source)
                await lease.close()
                return value
            } catch {
                await lease.close()
                throw error
            }
        } onCancel: {
            Task { await lease.close() }
        }
    }

    private static func awaitConfigResult(
        _ notifications: AsyncThrowingStream<Data, Error>,
        runtime: DeviceRuntime
    ) async throws -> WiFiConfigResult {
        try await withThrowingTaskGroup(of: WiFiConfigResult.self) { group in
            group.addTask {
                for try await data in notifications {
                    if let result = try? runtime.parseWiFiConfigResult(data) { return result }
                }
                throw endedWithoutResult("WiFi configuration")
            }
            group.addTask {
                try await Task.sleep(nanoseconds: operationTimeoutNanoseconds)
                throw timeout("WiFi configuration")
            }
            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }

    private static func awaitScanResult(
        _ notifications: AsyncThrowingStream<Data, Error>,
        runtime: DeviceRuntime
    ) async throws -> DeviceWiFiScanResult {
        try await withThrowingTaskGroup(of: DeviceWiFiScanResult.self) { group in
            group.addTask {
                for try await data in notifications {
                    switch try runtime.parseWiFiScanResult(data) {
                    case .pending:
                        continue
                    case let .done(result):
                        return result
                    }
                }
                throw endedWithoutResult("WiFi scan")
            }
            group.addTask {
                try await Task.sleep(nanoseconds: operationTimeoutNanoseconds)
                throw timeout("WiFi scan")
            }
            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }

    private static func timeout(_ label: String) -> BotaSDKError {
        BotaSDKError(
            code: .timeout,
            operation: .provision,
            retryable: true,
            detail: "\(label) timed out"
        )
    }

    private static func endedWithoutResult(_ label: String) -> BotaSDKError {
        BotaSDKError(
            code: .unexpectedEvent,
            operation: .provision,
            retryable: true,
            detail: "\(label) ended without a result"
        )
    }

    private static func cancelled(_ operation: BotaOperation) -> BotaSDKError {
        BotaSDKError(
            code: .cancelled,
            operation: operation,
            retryable: true,
            detail: "WiFi operation was cancelled"
        )
    }
}

private actor WiFiSubscriptionLease {
    private let runtime: DeviceRuntime
    private let deviceID: String
    private let characteristicUUID: String
    private var closed = false

    init(runtime: DeviceRuntime, deviceID: String, characteristicUUID: String) {
        self.runtime = runtime
        self.deviceID = deviceID
        self.characteristicUUID = characteristicUUID
    }

    func close() async {
        guard !closed else { return }
        closed = true
        try? await runtime.directUnsubscribe(
            deviceID,
            BotaBluetoothUUIDs.wifiService,
            characteristicUUID
        )
    }
}
