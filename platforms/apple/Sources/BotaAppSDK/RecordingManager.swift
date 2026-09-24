import BotaDeviceSDKC
import Foundation

public enum RecordingSyncEvent: Equatable, Sendable {
    case progress(RecordingTransferProgress)
    case completed(URL)
}

public struct RecordingTransferMetadata: Equatable, Sendable {
    public let isE2EEncrypted: Bool
    public let contentSHA256Hex: String?

    public init(isE2EEncrypted: Bool, contentSHA256Hex: String?) {
        self.isE2EEncrypted = isE2EEncrypted
        self.contentSHA256Hex = contentSHA256Hex
    }
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
    private var activeCleanup: (@Sendable () async -> Void)?
    private var activeEncryptedUploadV2Lifecycle: EncryptedUploadV2OperationLifecycle?
    private var transferMetadataBySinkID: [String: RecordingTransferMetadata] = [:]

    public init() {}

    func attach(_ runtime: DeviceRuntime) { self.runtime = runtime }

    func detach() async {
        activeTask?.cancel()
        if let id = activeCancellationID {
            if let lifecycle = activeEncryptedUploadV2Lifecycle, let runtime {
                await cancelEncryptedUploadV2(id, lifecycle: lifecycle, runtime: runtime)
            } else {
                try? await runtime?.engine.cancel(id)
                if let runtime { await finishCancellation(id, runtime: runtime) }
            }
        }
        activeTask = nil
        activeCancellationID = nil
        activeCleanup = nil
        transferMetadataBySinkID.removeAll()
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
        sinkID: String = UUID().uuidString,
        confirmOnCompletion: Bool = true
    ) async throws -> AsyncThrowingStream<RecordingSyncEvent, Error> {
        let runtime = try configuredRuntime()
        transferMetadataBySinkID.removeValue(forKey: sinkID)
        try await runtime.connection.require(device)
        let command = CoreCommand.transferRecording(
            serialNumber: device.serialNumber,
            recordingUUID: recording.uuid,
            sinkID: sinkID,
            totalUnits: recording.fileSizeBytes,
            confirmOnCompletion: confirmOnCompletion
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

    public func transferMetadata(sinkID: String) -> RecordingTransferMetadata? {
        transferMetadataBySinkID.removeValue(forKey: sinkID)
    }

    /// Runs only the explicitly selected v2 workflow. Legacy selection remains on the
    /// existing API and is never inferred or retried from a v2 failure.
    public func syncEncryptedRecordingV2(
        _ device: ConnectedDevice,
        recording: EncryptedUploadV2Recording,
        provider: @escaping EncryptedUploadV2ProfileProvider
    ) async throws {
        let cancellationID = UUID()
        let runtime = try configuredRuntime()
        let lifecycle = EncryptedUploadV2OperationLifecycle()
        return try await withTaskCancellationHandler {
            try await begin(cancellationID, operation: .transferRecording, runtime: runtime)
            activeEncryptedUploadV2Lifecycle = lifecycle
            do {
                try Task.checkCancellation()
                try await runtime.connection.require(device)
                try requireActive(cancellationID)
                let capability = try await runtime.readEncryptedUploadV2Capabilities(device.id)
                try requireActive(cancellationID)
                let checkpoint = try await runtime.encryptedUploadV2Checkpoint(
                    device.serialNumber,
                    recording.uuid,
                    recording.generation
                )
                try requireActive(cancellationID)
                let maximumFrameBytes = min(
                    try await runtime.encryptedUploadV2MaximumWriteLength(device.id),
                    512
                )
                let maximumMissingSequences = min(
                    Int(capability.capabilities.maximumMissingSequences),
                    (maximumFrameBytes - 68) / 4
                )
                let maximumWindowPackets = min(
                    Int(capability.capabilities.maximumWindowPackets),
                    maximumMissingSequences
                )
                let maximumDataPayloadBytes = min(
                    Int(capability.capabilities.maximumDataPayloadBytes),
                    maximumFrameBytes - 28
                )
                guard maximumFrameBytes >= 128,
                      maximumWindowPackets > 0,
                      maximumDataPayloadBytes > 0,
                      let negotiatedMaximumWindowPackets = UInt16(exactly: maximumWindowPackets),
                      let negotiatedMaximumDataPayloadBytes = UInt16(exactly: maximumDataPayloadBytes)
                else {
                    throw BotaSDKError(
                        code: .unsupportedCapability,
                        operation: .transferRecording,
                        retryable: false,
                        detail: "encrypted upload v2 negotiated bounds are unusable"
                    )
                }
                let material = try await provider(.init(
                    recording: recording,
                    capability: capability,
                    checkpoint: checkpoint
                ))
                await performEncryptedUploadV2Cleanup(lifecycle.accept(material), runtime: runtime)
                try requireActive(cancellationID)
                try Task.checkCancellation()
                try await runtime.connection.require(device)
                try requireActive(cancellationID)

                let transportSessionID: UInt64
                let sinkID: String
                let windowPackets: UInt16
                let dataPayloadBytes: UInt16
                if let checkpoint {
                    guard material.uploadSessionID == checkpoint.uploadSessionID,
                          material.ownerRevision == checkpoint.ownerRevision,
                          checkpoint.transportSessionID != 0,
                          UUID(uuidString: checkpoint.sinkID) != nil,
                          checkpoint.windowPackets > 0,
                          checkpoint.dataPayloadBytes > 0,
                          checkpoint.windowPackets <= negotiatedMaximumWindowPackets,
                          checkpoint.dataPayloadBytes <= negotiatedMaximumDataPayloadBytes
                    else {
                        throw BotaSDKError(
                            code: .integrityFailed,
                            operation: .transferRecording,
                            retryable: false,
                            detail: "encrypted upload v2 checkpoint does not match selected material"
                        )
                    }
                    transportSessionID = checkpoint.transportSessionID
                    sinkID = checkpoint.sinkID
                    windowPackets = checkpoint.windowPackets
                    dataPayloadBytes = checkpoint.dataPayloadBytes
                } else {
                    transportSessionID = Self.randomTransportSessionID()
                    sinkID = UUID().uuidString
                    windowPackets = negotiatedMaximumWindowPackets
                    dataPayloadBytes = negotiatedMaximumDataPayloadBytes
                }
                let command = CoreCommand.transferEncryptedRecording(.init(
                    serialNumber: device.serialNumber,
                    recordingUUID: recording.uuid,
                    recordingGeneration: recording.generation,
                    storageFormat: 3,
                    uploadSessionID: material.uploadSessionID,
                    ownerRevision: material.ownerRevision,
                    transportSessionID: transportSessionID,
                    materialID: material.materialID,
                    sinkID: sinkID,
                    profile: .encryptedUploadV2,
                    securityPolicy: material.policy.value,
                    capabilities: capability.capabilities.value,
                    windowPackets: windowPackets,
                    dataPayloadBytes: dataPayloadBytes,
                    ciphertextLength: recording.ciphertextLength,
                    ciphertextSHA256: recording.ciphertextSHA256
                ), cancellationID: cancellationID)
                try await runtime.registerEncryptedUploadV2Material(material.materialID, material)
                await performEncryptedUploadV2Cleanup(
                    lifecycle.register(material.materialID),
                    runtime: runtime
                )
                try requireActive(cancellationID)
                try Task.checkCancellation()
                var completed = false
                lifecycle.beginEngineStart()
                let notifications = await runtime.engine.run(command, capabilities: runtime.capabilities)
                if lifecycle.finishEngineStart() {
                    let exactlyCompleted: Bool
                    do {
                        exactlyCompleted = try await runtime.engine.cancelAndReportExactSettlement(cancellationID)
                    } catch {
                        if let sdkError = facadePublicError(error) as? BotaSDKError,
                           sdkError.code == .uploadOwnershipUnknown
                        {
                            lifecycle.preserveTerminalSettlement()
                        } else {
                            await performEncryptedUploadV2Cleanup(
                                lifecycle.settleEngineCancellation(completed: false),
                                runtime: runtime
                            )
                        }
                        await finish(cancellationID, runtime: runtime)
                        throw error
                    }
                    await performEncryptedUploadV2Cleanup(
                        lifecycle.settleEngineCancellation(completed: exactlyCompleted),
                        runtime: runtime
                    )
                    if exactlyCompleted {
                        await runtime.terminateEncryptedUploadV2Material(material.materialID, .completed)
                        await finish(cancellationID, runtime: runtime)
                        return
                    }
                    throw facadeCancelled(operation: .transferRecording)
                }
                for try await notification in notifications {
                    switch notification.kind {
                    case .completed:
                        completed = true
                    case .failed:
                        throw workflowError(notification)
                    case .cancelled:
                        throw facadeCancelled(operation: .transferRecording)
                    case .started, .encryptedUploadV2Staged:
                        break
                    case .deviceDiscovered, .connectionEstablished, .progress, .retrying,
                         .deviceUploadPreserved, .bleFallbackReady, .firmwareProgress, .deviceLog,
                         .streamingPaused, .streamingResumed, .streamingCompleted:
                        throw BotaSDKError(
                            code: .unexpectedEvent,
                            operation: .transferRecording,
                            retryable: false,
                            detail: "unexpected notification in encrypted upload v2 workflow"
                        )
                    }
                }
                guard completed else {
                    throw BotaSDKError(
                        code: .unexpectedEvent,
                        operation: .transferRecording,
                        retryable: false,
                        detail: "encrypted upload v2 workflow ended without completion"
                    )
                }
                lifecycle.complete()
                await runtime.terminateEncryptedUploadV2Material(material.materialID, .completed)
                await finish(cancellationID, runtime: runtime)
            } catch {
                let cleanup = lifecycle.failureCleanup()
                if !lifecycle.defersFailureCompletion() {
                    await performEncryptedUploadV2Cleanup(cleanup, runtime: runtime)
                    await finish(cancellationID, runtime: runtime)
                }
                throw facadePublicError(error)
            }
        } onCancel: {
            let cancellation = lifecycle.requestCancellation()
            Task {
                await self.cancelEncryptedUploadV2(
                    cancellationID,
                    lifecycle: lifecycle,
                    runtime: runtime,
                    cancellation: cancellation
                )
            }
        }
    }

    public func streamRecording(
        _ device: ConnectedDevice,
        recordingUUID: String,
        sinkID: String = UUID().uuidString,
        chunkSizeBytes: Int,
        flushIntervalMilliseconds: UInt64,
        destinationProvider: @escaping StreamingChunkDestinationProvider,
        finalize: @escaping StreamingFinalizeHandler
    ) async throws -> AsyncThrowingStream<StreamingRecordingEvent, Error> {
        let runtime = try configuredRuntime()
        try await runtime.connection.require(device)
        let command = CoreCommand.streamRecording(
            serialNumber: device.serialNumber,
            recordingUUID: recordingUUID,
            sinkID: sinkID
        )
        try await begin(command.cancellationID, operation: .transferRecording, runtime: runtime)
        do {
            try await runtime.registerStreamingSink(
                sinkID,
                chunkSizeBytes,
                flushIntervalMilliseconds,
                destinationProvider,
                finalize
            )
        } catch {
            await finish(command.cancellationID, runtime: runtime)
            throw facadePublicError(error)
        }
        activeCleanup = { await runtime.unregisterStreamingSink(sinkID) }
        let pair = AsyncThrowingStream<StreamingRecordingEvent, Error>.makeStream()
        let task = Task {
            await self.consumeStreaming(command, runtime: runtime, continuation: pair.continuation)
        }
        activeTask = task
        pair.continuation.onTermination = { @Sendable _ in
            Task { await self.cancel(command.cancellationID) }
        }
        return pair.stream
    }

    public func confirmRecording(
        _ device: ConnectedDevice,
        recordingUUID: String
    ) async throws {
        let runtime = try configuredRuntime()
        try await runtime.connection.require(device)
        let operationID = UUID()
        try await begin(operationID, operation: .transferRecording, runtime: runtime)
        do {
            try await runtime.directWrite(
                device.id,
                BotaBluetoothUUIDs.storageService,
                BotaBluetoothUUIDs.transferControl,
                runtime.createTransferCommand(.confirm(recordingUUID: recordingUUID))
            )
            await finish(operationID, runtime: runtime)
        } catch {
            await finish(operationID, runtime: runtime)
            throw error
        }
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
        if let lifecycle = activeEncryptedUploadV2Lifecycle {
            let cancellation = lifecycle.requestCancellation()
            if cancellation.cancelEngine {
                do {
                    let completed = try await runtime.engine.cancelAndReportExactSettlement(id)
                    let cleanup = lifecycle.settleEngineCancellation(completed: completed)
                    if !completed { activeTask?.cancel() }
                    await performEncryptedUploadV2Cleanup(cleanup, runtime: runtime)
                } catch {
                    lifecycle.preserveTerminalSettlement()
                    await finishCancellation(id, runtime: runtime)
                    throw error
                }
            } else {
                activeTask?.cancel()
                await performEncryptedUploadV2Cleanup(cancellation.cleanup, runtime: runtime)
            }
            if cancellation.isSettled || cancellation.cancelEngine {
                await finishCancellation(id, runtime: runtime)
            }
        } else {
            activeTask?.cancel()
            try await runtime.engine.cancel(id)
            await finishCancellation(id, runtime: runtime)
        }
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
                    transferMetadataBySinkID[sinkID] = Self.transferMetadata(notification)
                    continuation.yield(.completed(try await runtime.recordingFileURL(sinkID)))
                case .started, .deviceDiscovered, .connectionEstablished, .retrying,
                     .deviceUploadPreserved, .bleFallbackReady, .firmwareProgress,
                     .deviceLog, .streamingPaused, .streamingResumed, .streamingCompleted,
                     .encryptedUploadV2Staged:
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

    private static func transferMetadata(
        _ notification: CoreNotification
    ) -> RecordingTransferMetadata {
        let encrypted = notification.packet.fields.compactMap { field -> Bool? in
            guard case let .bool(id, value) = field,
                  id == UInt32(BOTA_DEVICE_SDK_V1_FIELD_ENCRYPTED)
            else { return nil }
            return value
        }.first ?? false
        let sha256 = notification.packet.fields.compactMap { field -> Data? in
            guard case let .bytes(id, value) = field, id == 123 else { return nil }
            return value
        }.first
        return RecordingTransferMetadata(
            isE2EEncrypted: encrypted,
            contentSHA256Hex: sha256.map { data in
                data.map { String(format: "%02x", $0) }.joined()
            }
        )
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
                     .firmwareProgress, .deviceLog, .streamingPaused, .streamingResumed,
                     .streamingCompleted, .encryptedUploadV2Staged:
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

    private func consumeStreaming(
        _ command: CoreCommand,
        runtime: DeviceRuntime,
        continuation: AsyncThrowingStream<StreamingRecordingEvent, Error>.Continuation
    ) async {
        do {
            let notifications = await runtime.engine.run(command, capabilities: runtime.capabilities)
            for try await notification in notifications {
                switch notification.kind {
                case .streamingPaused:
                    continuation.yield(.paused(completedBytes: try unsigned(notification, 36)))
                case .streamingResumed:
                    continuation.yield(.resumed)
                case .streamingCompleted:
                    continuation.yield(.completed(
                        totalBytes: try unsigned(notification, 15),
                        uploadedChunks: UInt32(try unsigned(notification, 126)),
                        isEncrypted: try boolean(notification, 90)
                    ))
                case .failed:
                    throw workflowError(notification)
                case .cancelled:
                    throw facadeCancelled(operation: .transferRecording)
                case .started, .deviceDiscovered, .connectionEstablished, .progress, .retrying,
                     .deviceUploadPreserved, .bleFallbackReady, .firmwareProgress, .deviceLog,
                     .encryptedUploadV2Staged, .completed:
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
            throw BotaSDKError(
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
        let cleanup = activeCleanup
        activeCancellationID = nil
        activeTask = nil
        activeCleanup = nil
        activeEncryptedUploadV2Lifecycle = nil
        await cleanup?()
        await runtime.operations.end(id)
    }

    private func finishCancellation(_ id: UUID, runtime: DeviceRuntime) async {
        guard activeCancellationID == id else { return }
        await finish(id, runtime: runtime)
    }

    private func cancel(_ id: UUID) async {
        guard activeCancellationID == id, let runtime else { return }
        if let lifecycle = activeEncryptedUploadV2Lifecycle {
            await cancelEncryptedUploadV2(
                id,
                lifecycle: lifecycle,
                runtime: runtime
            )
        } else {
            activeTask?.cancel()
            try? await runtime.engine.cancel(id)
            await finishCancellation(id, runtime: runtime)
        }
    }

    private func cancelEncryptedUploadV2(
        _ id: UUID,
        lifecycle: EncryptedUploadV2OperationLifecycle,
        runtime: DeviceRuntime,
        cancellation: EncryptedUploadV2OperationLifecycle.Cancellation? = nil
    ) async {
        let cancellation = cancellation ?? lifecycle.requestCancellation()
        guard activeCancellationID == id else {
            // Cleanup was claimed before the actor hop and still belongs to this runtime.
            await performEncryptedUploadV2Cleanup(cancellation.cleanup, runtime: runtime)
            return
        }
        if cancellation.cancelEngine {
            do {
                let completed = try await runtime.engine.cancelAndReportExactSettlement(id)
                let cleanup = lifecycle.settleEngineCancellation(completed: completed)
                if !completed { activeTask?.cancel() }
                await performEncryptedUploadV2Cleanup(cleanup, runtime: runtime)
            } catch {
                lifecycle.preserveTerminalSettlement()
            }
        } else {
            activeTask?.cancel()
            await performEncryptedUploadV2Cleanup(cancellation.cleanup, runtime: runtime)
        }
        if cancellation.isSettled || cancellation.cancelEngine {
            await finishCancellation(id, runtime: runtime)
        }
    }

    private func performEncryptedUploadV2Cleanup(
        _ cleanup: EncryptedUploadV2OperationLifecycle.Cleanup,
        runtime: DeviceRuntime
    ) async {
        switch cleanup {
        case .none:
            break
        case let .cancelPreparation(material):
            await material.cancelPreparation()
        case let .terminate(materialID, outcome):
            await runtime.terminateEncryptedUploadV2Material(materialID, outcome)
        }
    }

    private func configuredRuntime() throws -> DeviceRuntime {
        guard let runtime else { throw facadeNotConfigured() }
        return runtime
    }

    private func requireActive(_ id: UUID) throws {
        guard activeCancellationID == id else {
            throw facadeCancelled(operation: .transferRecording)
        }
    }

    private static func randomTransportSessionID() -> UInt64 {
        UInt64.random(in: 1...UInt64.max)
    }
}

private final class EncryptedUploadV2OperationLifecycle: @unchecked Sendable {
    enum Cleanup {
        case none
        case cancelPreparation(EncryptedUploadV2Material)
        case terminate(String, EncryptedUploadV2TerminalOutcome)
    }

    struct Cancellation {
        let cancelEngine: Bool
        let cleanup: Cleanup
        let isSettled: Bool
    }

    private enum EnginePhase {
        case notStarted
        case starting
        case started
    }

    private let lock = NSLock()
    private var material: EncryptedUploadV2Material?
    private var materialID: String?
    private var enginePhase = EnginePhase.notStarted
    private var cancellationRequested = false
    private var didCancelPreparation = false
    private var didTerminate = false
    private var completed = false
    private var engineCancellationSettled = false

    func accept(_ material: EncryptedUploadV2Material) -> Cleanup {
        lock.withLock {
            self.material = material
            return cancellationRequested ? takeCleanup(.cancelled) : .none
        }
    }

    func register(_ materialID: String) -> Cleanup {
        lock.withLock {
            self.materialID = materialID
            guard cancellationRequested, enginePhase != .starting else { return .none }
            return takeCleanup(.cancelled)
        }
    }

    func beginEngineStart() {
        lock.withLock { enginePhase = .starting }
    }

    func finishEngineStart() -> Bool {
        lock.withLock {
            enginePhase = .started
            return cancellationRequested
        }
    }

    func requestCancellation() -> Cancellation {
        lock.withLock {
            cancellationRequested = true
            guard enginePhase != .starting else {
                return .init(cancelEngine: false, cleanup: .none, isSettled: false)
            }
            return .init(
                cancelEngine: enginePhase == .started,
                cleanup: enginePhase == .started ? .none : takeCleanup(.cancelled),
                isSettled: enginePhase != .started
            )
        }
    }

    func settleEngineCancellation(completed exactlyCompleted: Bool) -> Cleanup {
        lock.withLock {
            engineCancellationSettled = true
            if exactlyCompleted {
                completed = true
                return .none
            }
            return takeCleanup(.cancelled)
        }
    }

    func preserveTerminalSettlement() {
        lock.withLock {
            engineCancellationSettled = true
            completed = true
        }
    }

    func defersFailureCompletion() -> Bool {
        lock.withLock {
            cancellationRequested && enginePhase == .started && !completed && !engineCancellationSettled
        }
    }

    func cancellationCleanup() -> Cleanup {
        lock.withLock { takeCleanup(.cancelled) }
    }

    func failureCleanup() -> Cleanup {
        lock.withLock {
            if cancellationRequested && enginePhase == .started && !engineCancellationSettled { return .none }
            return takeCleanup(cancellationRequested ? .cancelled : .failed)
        }
    }

    func complete() {
        lock.withLock { completed = true }
    }

    private func takeCleanup(_ outcome: EncryptedUploadV2TerminalOutcome) -> Cleanup {
        guard !completed else { return .none }
        if let materialID, !didTerminate {
            didTerminate = true
            return .terminate(materialID, outcome)
        }
        if let material, !didCancelPreparation {
            didCancelPreparation = true
            return .cancelPreparation(material)
        }
        return .none
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

func boolean(_ notification: CoreNotification, _ id: UInt32) throws -> Bool {
    for field in notification.packet.fields {
        if case let .bool(fieldID, value) = field, fieldID == id { return value }
    }
    throw NativeHostError.missingField(id)
}

func facadeCancelled(operation: BotaOperation) -> BotaSDKError {
    BotaSDKError(
        code: .cancelled,
        operation: operation,
        retryable: true,
        detail: "device workflow was cancelled"
    )
}

func facadeNotConfigured() -> BotaSDKError {
    BotaSDKError(
        code: .featureUnavailable,
        operation: .validate,
        retryable: false,
        detail: "BotaDeviceClient.configure() must be called first"
    )
}

func facadePublicError(_ error: Error) -> Error {
    if let error = error as? BotaSDKError { return error }
    if let error = error as? CoreError { return BotaSDKError(error) }
    return error
}
