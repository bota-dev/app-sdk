import BotaDeviceSDKC
import Foundation

public actor DeviceLogManager {
    private struct ActiveOperation {
        let id: UUID
        let cancel: @Sendable () -> Void
        let wait: @Sendable () async throws -> Void
    }

    private struct CleanupFailure: Error { let underlying: Error }

    private var runtime: DeviceRuntime?
    private var active: ActiveOperation?
    private let diagnosticTimeoutMilliseconds: UInt64

    public init() { diagnosticTimeoutMilliseconds = 30_000 }

    init(diagnosticTimeoutMilliseconds: UInt64) {
        self.diagnosticTimeoutMilliseconds = diagnosticTimeoutMilliseconds
    }

    func attach(_ runtime: DeviceRuntime) {
        if let current = self.runtime, current.operations !== runtime.operations { active?.cancel() }
        self.runtime = runtime
    }

    func detach() async {
        runtime = nil
        let operation = active
        operation?.cancel()
        try? await operation?.wait()
        if active?.id == operation?.id { active = nil }
    }

    public func streamLogs(
        _ device: ConnectedDevice
    ) async throws -> AsyncThrowingStream<DeviceLogLine, Error> {
        let command = CoreCommand.readDeviceLogs(serialNumber: device.serialNumber)
        let pair = AsyncThrowingStream<DeviceLogLine, Error>.makeStream()
        let task = try startOperation(device, id: command.cancellationID) { runtime in
            try await Self.consume(command, runtime: runtime, continuation: pair.continuation)
        }
        Task {
            do { try await task.value; pair.continuation.finish() }
            catch { pair.continuation.finish(throwing: error) }
        }
        pair.continuation.onTermination = { @Sendable _ in
            task.cancel()
        }
        return pair.stream
    }

    public func stop() async throws {
        let operation = active
        operation?.cancel()
        do { try await operation?.wait() }
        catch let error as BotaSDKError where error.code == .cancelled {}
    }

    public func readDiagnosticEvents(_ device: ConnectedDevice) async throws -> DeviceDiagnosticsBatch {
        let timeout = diagnosticTimeoutMilliseconds
        return try await performOperation(device) { runtime in
            let result = await withTaskGroup(of: Result<DeviceDiagnosticsBatch, Error>.self) { group in
                group.addTask {
                    do { return .success(try await Self.readDiagnostics(device, runtime: runtime)) }
                    catch { return .failure(error) }
                }
                group.addTask {
                    do {
                        try await runtime.delay(timeout)
                        return .failure(BotaSDKError(
                            code: .timeout, operation: .readDeviceLogs, retryable: true,
                            detail: "device diagnostics timed out"
                        ))
                    } catch { return .failure(error) }
                }
                var result = await group.next()!
                group.cancelAll()
                // A timeout/cancellation must not hide a later failed native cleanup.
                for await remaining in group {
                    if case let .failure(error) = remaining, error is CleanupFailure { result = remaining }
                }
                return result
            }
            return try result.get()
        }
    }

    public func acknowledgeDiagnosticEvents(_ device: ConnectedDevice, acceptedEventIds: [String]) async throws {
        try await performOperation(device) { runtime in
            let generation = try await runtime.connection.generation(for: device)
            // Rust validates every ID before the first device mutation.
            let commands = try acceptedEventIds.map { try runtime.createDiagnosticCommand($0) }
            for command in commands {
                try Task.checkCancellation()
                try await runtime.connection.require(device, generation: generation)
                try Task.checkCancellation()
                try await runtime.directWrite(device.id, Self.service, Self.control, command)
                try await runtime.connection.require(device, generation: generation)
            }
        }
    }

    private static let service = "b07a0007-0000-1000-8000-00805f9b34fb"
    private static let control = "b07a0007-0001-1000-8000-00805f9b34fb"
    private static let data = "b07a0007-0002-1000-8000-00805f9b34fb"

    private static func readDiagnostics(_ device: ConnectedDevice, runtime: DeviceRuntime) async throws -> DeviceDiagnosticsBatch {
        let generation = try await runtime.connection.generation(for: device)
        try Task.checkCancellation()
        _ = try runtime.decodeDiagnosticEvents(Data())
        defer { _ = try? runtime.decodeDiagnosticEvents(Data()) }
        let command = try runtime.createDiagnosticCommand(nil)
        let result: Result<DeviceDiagnosticsBatch, Error>
        do {
            let source = try await runtime.directSubscribe(device.id, service, data)
            try Task.checkCancellation()
            try await runtime.connection.require(device, generation: generation)
            try Task.checkCancellation()
            try await runtime.directWrite(device.id, service, control, command)
            var batch: DeviceDiagnosticsBatch?
            for try await packet in source {
                try Task.checkCancellation()
                try await runtime.connection.require(device, generation: generation)
                try Task.checkCancellation()
                if let value = try runtime.decodeDiagnosticEvents(packet) { batch = value; break }
            }
            try Task.checkCancellation()
            guard let batch else {
                throw BotaSDKError(code: .unexpectedEvent, operation: .readDeviceLogs, retryable: true,
                                   detail: "device diagnostics ended without a complete batch")
            }
            result = .success(batch)
        } catch { result = .failure(error) }
        // Join cleanup on the captured runtime before releasing the shared operation owner.
        if await runtime.connection.ownsGeneration(generation) {
            let cleanup = await Task { try await runtime.directUnsubscribe(device.id, service, data) }.result
            if case let .failure(error) = cleanup { throw CleanupFailure(underlying: error) }
        }
        let batch = try result.get()
        try await runtime.connection.require(device, generation: generation)
        try Task.checkCancellation()
        return batch
    }

    private func performOperation<T: Sendable>(
        _ device: ConnectedDevice,
        body: @escaping @Sendable (DeviceRuntime) async throws -> T
    ) async throws -> T {
        let task = try startOperation(device, body: body)
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }

    private func startOperation<T: Sendable>(
        _ device: ConnectedDevice, id: UUID = UUID(),
        body: @escaping @Sendable (DeviceRuntime) async throws -> T
    ) throws -> Task<T, Error> {
        guard let runtime else { throw facadeNotConfigured() }
        guard active == nil else {
            throw BotaSDKError(code: .operationInProgress, operation: .readDeviceLogs, retryable: false,
                               detail: "device logs or diagnostics are already active")
        }
        let task = Task<T, Error> {
            do {
                try Task.checkCancellation()
                try runtime.authorize(.readDeviceLogs)
                try await runtime.operations.begin(id, operation: .readDeviceLogs)
                try Task.checkCancellation()
                try await runtime.connection.require(device)
                let value = try await body(runtime)
                await finish(id, runtime: runtime)
                return value
            } catch let error as CleanupFailure {
                // Retain the captured runtime's owner when native cleanup is unconfirmed.
                throw facadePublicError(error.underlying)
            } catch {
                await finish(id, runtime: runtime)
                if error is CancellationError { throw facadeCancelled(operation: .readDeviceLogs) }
                throw facadePublicError(error)
            }
        }
        // Register pending startup before the first actor hop.
        active = ActiveOperation(id: id, cancel: { task.cancel() }, wait: { _ = try await task.value })
        return task
    }

    private static func consume(
        _ command: CoreCommand,
        runtime: DeviceRuntime,
        continuation: AsyncThrowingStream<DeviceLogLine, Error>.Continuation
    ) async throws {
        do {
            let notifications = await runtime.engine.run(command, capabilities: runtime.capabilities)
            try Task.checkCancellation()
            for try await notification in notifications {
                switch notification.kind {
                case .deviceLog:
                    continuation.yield(DeviceLogLine(
                        message: try text(notification, UInt32(BOTA_DEVICE_SDK_V1_FIELD_LOG_MESSAGE)),
                        isBacklog: try bool(notification, UInt32(BOTA_DEVICE_SDK_V1_FIELD_IS_BACKLOG))
                    ))
                case .failed:
                    throw workflowError(notification)
                case .cancelled:
                    throw facadeCancelled(operation: .readDeviceLogs)
                case .started, .deviceDiscovered, .connectionEstablished, .progress,
                     .retrying, .deviceUploadPreserved, .bleFallbackReady,
                     .firmwareProgress, .streamingPaused, .streamingResumed,
                     .streamingCompleted, .encryptedUploadV2Staged, .completed:
                    break
                }
            }
            try Task.checkCancellation()
        } catch {
            if Task.isCancelled {
                do { try await runtime.engine.cancel(command.cancellationID) }
                catch { throw CleanupFailure(underlying: error) }
            }
            throw error
        }
    }

    private func finish(_ id: UUID, runtime: DeviceRuntime) async {
        await runtime.operations.end(id)
        if active?.id == id { active = nil }
    }
}

private func bool(_ notification: CoreNotification, _ id: UInt32) throws -> Bool {
    for field in notification.packet.fields {
        if case let .bool(fieldID, value) = field, fieldID == id { return value }
    }
    throw NativeHostError.missingField(id)
}
