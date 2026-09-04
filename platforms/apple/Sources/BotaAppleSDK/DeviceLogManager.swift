import BotaDeviceSDKC
import Foundation

public actor DeviceLogManager {
    private var runtime: DeviceRuntime?
    private var activeCancellationID: UUID?
    private var activeTask: Task<Void, Never>?

    public init() {}

    func attach(_ runtime: DeviceRuntime) { self.runtime = runtime }

    func detach() async {
        activeTask?.cancel()
        if let id = activeCancellationID {
            try? await runtime?.engine.cancel(id)
            await runtime?.operations.end(id)
        }
        activeTask = nil
        activeCancellationID = nil
        runtime = nil
    }

    public func streamLogs(
        _ device: ConnectedDevice
    ) async throws -> AsyncThrowingStream<DeviceLogLine, Error> {
        guard let runtime else { throw facadeNotConfigured() }
        try await runtime.connection.require(device)
        let command = CoreCommand.readDeviceLogs(serialNumber: device.serialNumber)
        guard activeCancellationID == nil else {
            throw BotaSDKError(
                code: .operationInProgress,
                operation: .readDeviceLogs,
                retryable: false,
                detail: "device logs are already streaming"
            )
        }
        try await runtime.operations.begin(command.cancellationID, operation: .readDeviceLogs)
        activeCancellationID = command.cancellationID
        let pair = AsyncThrowingStream<DeviceLogLine, Error>.makeStream()
        let task = Task {
            await self.consume(command, runtime: runtime, continuation: pair.continuation)
        }
        activeTask = task
        pair.continuation.onTermination = { @Sendable _ in
            Task { await self.cancel(command.cancellationID) }
        }
        return pair.stream
    }

    public func stop() async throws {
        guard let id = activeCancellationID, let runtime else { return }
        activeTask?.cancel()
        try await runtime.engine.cancel(id)
        await finish(id, runtime: runtime)
    }

    private func consume(
        _ command: CoreCommand,
        runtime: DeviceRuntime,
        continuation: AsyncThrowingStream<DeviceLogLine, Error>.Continuation
    ) async {
        do {
            let notifications = await runtime.engine.run(command, capabilities: runtime.capabilities)
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
            await finish(command.cancellationID, runtime: runtime)
            continuation.finish()
        } catch {
            await finish(command.cancellationID, runtime: runtime)
            continuation.finish(throwing: facadePublicError(error))
        }
    }

    private func finish(_ id: UUID, runtime: DeviceRuntime) async {
        guard activeCancellationID == id else { return }
        activeCancellationID = nil
        activeTask = nil
        await runtime.operations.end(id)
    }

    private func cancel(_ id: UUID) async {
        guard activeCancellationID == id, let runtime else { return }
        activeTask?.cancel()
        try? await runtime.engine.cancel(id)
        await finish(id, runtime: runtime)
    }
}

private func bool(_ notification: CoreNotification, _ id: UInt32) throws -> Bool {
    for field in notification.packet.fields {
        if case let .bool(fieldID, value) = field, fieldID == id { return value }
    }
    throw NativeHostError.missingField(id)
}
