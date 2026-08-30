import BotaDeviceSDKC
import Foundation

public enum RecordingSyncEvent: Equatable, Sendable {
    case progress(RecordingTransferProgress)
    case completed(URL)
}

public enum UploadOwnershipResult: Equatable, Sendable {
    case deviceUploadCompleted
    case deviceUploadPreserved(uploadID: String)
    case bluetoothFallback(recordingUUID: String, uploadID: String, destinationID: String)
}

public enum UploadOwnershipEvent: Equatable, Sendable {
    case progress(RecordingTransferProgress)
    case result(UploadOwnershipResult)
}

public actor RecordingManager {
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

    public func listRecordings(_ device: ConnectedDevice) async throws -> [DeviceRecording] {
        let runtime = try configuredRuntime()
        try await runtime.connection.require(device)
        let operationID = UUID()
        try await begin(operationID, operation: .transferRecording, runtime: runtime)
        do {
            let notifications = try await runtime.directSubscribe(
                device.id,
                BotaBluetoothUUIDs.storageService,
                BotaBluetoothUUIDs.recordingList
            )
            let command = try runtime.createTransferCommand(.list)
            try await runtime.directWrite(
                device.id,
                BotaBluetoothUUIDs.storageService,
                BotaBluetoothUUIDs.transferControl,
                command
            )
            var iterator = notifications.makeAsyncIterator()
            let data = try await iterator.next() ?? Data()
            try? await runtime.directUnsubscribe(
                device.id,
                BotaBluetoothUUIDs.storageService,
                BotaBluetoothUUIDs.recordingList
            )
            await finish(operationID, runtime: runtime)
            return try runtime.parseRecordingList(data)
        } catch {
            try? await runtime.directUnsubscribe(
                device.id,
                BotaBluetoothUUIDs.storageService,
                BotaBluetoothUUIDs.recordingList
            )
            await finish(operationID, runtime: runtime)
            throw error
        }
    }

    public func syncRecording(
        _ device: ConnectedDevice,
        recording: DeviceRecording,
        sinkID: String = UUID().uuidString
    ) async throws -> AsyncThrowingStream<RecordingSyncEvent, Error> {
        let runtime = try configuredRuntime()
        try await runtime.connection.require(device)
        let command = CoreCommand.transferRecording(
            serialNumber: device.serialNumber,
            recordingUUID: recording.uuid,
            sinkID: sinkID,
            totalUnits: recording.fileSizeBytes
        )
        try await begin(command.cancellationID, operation: .transferRecording, runtime: runtime)
        let pair = AsyncThrowingStream<RecordingSyncEvent, Error>.makeStream()
        let task = Task {
            await self.consumeTransfer(
                command,
                sinkID: sinkID,
                runtime: runtime,
                continuation: pair.continuation
            )
        }
        activeTask = task
        pair.continuation.onTermination = { @Sendable _ in
            Task { await self.cancel(command.cancellationID) }
        }
        return pair.stream
    }

    public func observeUploadOwnership(
        _ device: ConnectedDevice,
        recordingUUID: String,
        uploadID: String,
        destinationID: String
    ) async throws -> AsyncThrowingStream<UploadOwnershipEvent, Error> {
        let runtime = try configuredRuntime()
        try await runtime.connection.require(device)
        let command = CoreCommand.uploadRecording(
            serialNumber: device.serialNumber,
            recordingUUID: recordingUUID,
            uploadID: uploadID,
            destinationID: destinationID
        )
        try await begin(command.cancellationID, operation: .upload, runtime: runtime)
        let pair = AsyncThrowingStream<UploadOwnershipEvent, Error>.makeStream()
        let task = Task {
            await self.consumeOwnership(command, runtime: runtime, continuation: pair.continuation)
        }
        activeTask = task
        pair.continuation.onTermination = { @Sendable _ in
            Task { await self.cancel(command.cancellationID) }
        }
        return pair.stream
    }

    public func cancelCurrentOperation() async throws {
        guard let id = activeCancellationID else { return }
        let runtime = try configuredRuntime()
        activeTask?.cancel()
        try await runtime.engine.cancel(id)
        await finish(id, runtime: runtime)
    }

    private func consumeTransfer(
        _ command: CoreCommand,
        sinkID: String,
        runtime: DeviceRuntime,
        continuation: AsyncThrowingStream<RecordingSyncEvent, Error>.Continuation
    ) async {
        do {
            let notifications = await runtime.engine.run(command, capabilities: runtime.capabilities)
            for try await notification in notifications {
                switch notification.kind {
                case .progress:
                    continuation.yield(.progress(try transferProgress(notification)))
                case .failed:
                    throw workflowError(notification)
                case .cancelled:
                    throw facadeCancelled(operation: .transferRecording)
                case .completed:
                    continuation.yield(.completed(try await runtime.recordingFileURL(sinkID)))
                case .started, .deviceDiscovered, .connectionEstablished, .retrying,
                     .deviceUploadPreserved, .bleFallbackReady, .firmwareProgress,
                     .deviceLog:
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

    private func consumeOwnership(
        _ command: CoreCommand,
        runtime: DeviceRuntime,
        continuation: AsyncThrowingStream<UploadOwnershipEvent, Error>.Continuation
    ) async {
        var result: UploadOwnershipResult = .deviceUploadCompleted
        do {
            let notifications = await runtime.engine.run(command, capabilities: runtime.capabilities)
            for try await notification in notifications {
                switch notification.kind {
                case .progress:
                    continuation.yield(.progress(try transferProgress(notification)))
                case .deviceUploadPreserved:
                    result = .deviceUploadPreserved(uploadID: try text(
                        notification,
                        UInt32(BOTA_DEVICE_SDK_V1_FIELD_UPLOAD_ID)
                    ))
                case .bleFallbackReady:
                    result = .bluetoothFallback(
                        recordingUUID: try text(notification, UInt32(BOTA_DEVICE_SDK_V1_FIELD_RECORDING_UUID)),
                        uploadID: try text(notification, UInt32(BOTA_DEVICE_SDK_V1_FIELD_UPLOAD_ID)),
                        destinationID: try text(notification, UInt32(BOTA_DEVICE_SDK_V1_FIELD_DESTINATION_ID))
                    )
                case .failed:
                    throw workflowError(notification)
                case .cancelled:
                    throw facadeCancelled(operation: .upload)
                case .completed:
                    continuation.yield(.result(result))
                case .started, .deviceDiscovered, .connectionEstablished, .retrying,
                     .firmwareProgress, .deviceLog:
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

    private func begin(_ id: UUID, operation: BotaOperation, runtime: DeviceRuntime) async throws {
        guard activeCancellationID == nil else {
            throw BotaDeviceSDKError(
                code: .operationInProgress,
                operation: operation,
                retryable: false,
                detail: "another recording operation is already active"
            )
        }
        try await runtime.operations.begin(id, operation: operation)
        activeCancellationID = id
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

    private func configuredRuntime() throws -> DeviceRuntime {
        guard let runtime else { throw facadeNotConfigured() }
        return runtime
    }
}

private func transferProgress(_ notification: CoreNotification) throws -> RecordingTransferProgress {
    .init(
        completedBytes: try unsigned(notification, UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMPLETED_UNITS)),
        totalBytes: try unsigned(notification, UInt32(BOTA_DEVICE_SDK_V1_FIELD_TOTAL_UNITS))
    )
}

func text(_ notification: CoreNotification, _ id: UInt32) throws -> String {
    for field in notification.packet.fields {
        if case let .text(fieldID, value) = field, fieldID == id { return value }
    }
    throw NativeHostError.missingField(id)
}

func unsigned(_ notification: CoreNotification, _ id: UInt32) throws -> UInt64 {
    for field in notification.packet.fields {
        if case let .unsigned(fieldID, value) = field, fieldID == id { return value }
    }
    throw NativeHostError.missingField(id)
}

func facadeCancelled(operation: BotaOperation) -> BotaDeviceSDKError {
    BotaDeviceSDKError(
        code: .cancelled,
        operation: operation,
        retryable: true,
        detail: "device workflow was cancelled"
    )
}

func facadeNotConfigured() -> BotaDeviceSDKError {
    BotaDeviceSDKError(
        code: .featureUnavailable,
        operation: .validate,
        retryable: false,
        detail: "BotaDeviceClient.configure() must be called first"
    )
}

func facadePublicError(_ error: Error) -> Error {
    if let error = error as? BotaDeviceSDKError { return error }
    if let error = error as? CoreError { return BotaDeviceSDKError(error) }
    return error
}
