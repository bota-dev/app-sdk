import CryptoKit
import Darwin
import Foundation

enum EncryptedUploadV2TransferOpenResult: Sendable {
    case opened(AsyncThrowingStream<Data, Error>)
    case resumeRejected
}

actor EncryptedUploadV2TransferHost: EncryptedUploadV2Host {
    typealias OpenTransfer = @Sendable (
        EncryptedUploadV2StartRequestValue,
        EncryptedUploadV2CheckpointValue?
    ) async throws -> EncryptedUploadV2TransferOpenResult
    typealias SendControl = @Sendable (Data) async throws -> Void
    typealias AbortTransfer = @Sendable (UInt64) async throws -> Void

    fileprivate struct Context: Sendable {
        let serialNumber: String
        let recordingUUID: String
        let recordingGeneration: UInt32
        let uploadSessionID: UUID
        let uploadSessionBytes: Data
        let ownerRevision: UInt32
        let transportSessionID: UInt64
        let sinkID: String
        let windowPackets: UInt16
        let dataPayloadBytes: UInt16
        let checkpointIntervalBlocks: UInt32
        let maximumDataPayloadBytes: UInt16
        let maximumWindowPackets: UInt16
        let maximumMissingSequences: UInt16
        let ciphertextLength: UInt64
        let ciphertextSHA256: Data
        let authorizationSHA256: Data
    }

    private struct ActiveTransfer: Sendable {
        let context: Context
        let receiver: EncryptedUploadV2TransferReceiver
        let reader: EncryptedUploadV2NotificationReader
    }

    private let rootDirectory: URL
    private let mapper: CoreModelMapper
    private let openTransfer: OpenTransfer
    private let sendControl: SendControl
    private let abortTransfer: AbortTransfer
    private let checkpointStore: EncryptedUploadV2DurableFileStore
    private var activeTransfer: ActiveTransfer?
    private var loadedCheckpoint: PersistedEncryptedUploadV2Checkpoint?
    private var pendingCheckpoint: EncryptedUploadV2CheckpointValue?
    private var pendingMissingSequences: [UInt32] = []
    private var persistedCoreCheckpoint: Data?
    private var startContinuation: AsyncThrowingStream<CoreHostEventPayload, Error>.Continuation?
    private var retainedTransportSessionID: UInt64?
    private var openingTransportSessionID: UInt64?
    private var openingTask: Task<EncryptedUploadV2TransferOpenResult, Error>?
    private var pumpTask: Task<Void, Never>?
    private var generation: UInt64 = 0

    init(
        rootDirectory: URL,
        mapper: CoreModelMapper,
        openTransfer: @escaping OpenTransfer,
        sendControl: @escaping SendControl,
        abortTransfer: @escaping AbortTransfer = { _ in },
        checkpointStore: EncryptedUploadV2DurableFileStore = .init()
    ) {
        self.rootDirectory = rootDirectory
        self.mapper = mapper
        self.openTransfer = openTransfer
        self.sendControl = sendControl
        self.abortTransfer = abortTransfer
        self.checkpointStore = checkpointStore
    }

    init(
        rootDirectory: URL,
        mapper: CoreModelMapper,
        transferControl: EncryptedUploadV2TransferControl,
        resolvePeripheralID: @escaping @Sendable () async throws -> String
    ) {
        self.init(
            rootDirectory: rootDirectory,
            mapper: mapper,
            openTransfer: { request, checkpoint in
                let peripheralID = try await resolvePeripheralID()
                if let checkpoint {
                    let decision = try await transferControl.resume(
                        peripheralID: peripheralID,
                        request: .init(
                            transportSessionID: request.transportSessionID,
                            uploadSessionID: request.uploadSessionID,
                            recordingUUID: request.recordingUUID,
                            recordingGeneration: request.recordingGeneration,
                            checkpointRevision: checkpoint.revision,
                            nextCiphertextOffset: checkpoint.nextCiphertextOffset,
                            prefixSHA256: checkpoint.prefixSHA256,
                            windowPackets: request.windowPackets,
                            dataPayloadBytes: request.dataPayloadBytes
                        )
                    )
                    if case .rejected = decision { return .resumeRejected }
                } else {
                    _ = try await transferControl.start(
                        peripheralID: peripheralID,
                        request: request
                    )
                }
                return .opened(try await transferControl.claimNotificationStream(
                    transportSessionID: request.transportSessionID
                ))
            },
            sendControl: { frame in
                guard frame.count >= 12 else {
                    throw Self.failure(code: 1, detail: "encrypted transfer frame is truncated")
                }
                try await transferControl.writeActiveTransferFrame(
                    transportSessionID: Self.readUInt64(frame, at: 4),
                    frame: frame
                )
            },
            abortTransfer: { transportSessionID in
                try await transferControl.abortActiveTransfer(
                    transportSessionID: transportSessionID,
                    reason: 0x00FF
                )
            }
        )
    }

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        do {
            switch effect {
            case .encryptedUploadV2LoadCheckpoint:
                return try loadCheckpoint(effect)
            case .encryptedUploadV2DeleteCheckpoint:
                return try deleteCheckpoint(effect)
            case .encryptedUploadV2TruncateSink:
                return try truncateSink(effect)
            case .encryptedUploadV2StartTransfer:
                return try await start(effect)
            case .encryptedUploadV2SaveCheckpoint:
                return try await saveCheckpoint(effect)
            case .encryptedUploadV2RepairWindow:
                return try await repairWindow(effect)
            case .encryptedUploadV2AcknowledgeWindow:
                return try await acknowledgeWindow(effect)
            case .encryptedUploadV2Abort:
                return try await abort()
            default:
                return Self.failedStream("encrypted upload v2 transfer effect is not implemented")
            }
        } catch {
            return AsyncThrowingStream { $0.finish(throwing: error) }
        }
    }

    private func abort() async throws -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        generation &+= 1
        let active = activeTransfer
        let sessionID = retainedTransportSessionID ?? openingTransportSessionID
        let openingTask = self.openingTask
        let pumpTask = self.pumpTask
        openingTask?.cancel()
        pumpTask?.cancel()
        startContinuation?.finish()
        await active?.reader.cancel()
        activeTransfer = nil
        pendingCheckpoint = nil
        pendingMissingSequences = []
        persistedCoreCheckpoint = nil
        startContinuation = nil
        self.pumpTask = nil
        await pumpTask?.value

        var openedDuringCancellation = false
        if let openingTask {
            if case let .success(result) = await openingTask.result,
               case .opened = result
            {
                openedDuringCancellation = true
            }
        }
        if let sessionID, retainedTransportSessionID != nil || openedDuringCancellation {
            do {
                try await abortTransfer(sessionID)
                retainedTransportSessionID = nil
            } catch {
                retainedTransportSessionID = sessionID
                openingTransportSessionID = nil
                self.openingTask = nil
                throw error
            }
        }
        openingTransportSessionID = nil
        self.openingTask = nil
        return Self.empty()
    }

    private func deleteCheckpoint(
        _ effect: CoreEffect
    ) throws -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        let bytes = try effect.packet.fields.v2RequiredBytes(EncryptedUploadV2Abi.fieldUploadSessionUUID)
        guard let uploadSessionID = UUID(v2Bytes: bytes) else {
            throw Self.failure(code: 1, detail: "upload session UUID is invalid")
        }
        let url = Self.checkpointURL(uploadSessionID: uploadSessionID, rootDirectory: rootDirectory)
        try checkpointStore.removeIfPresent(url)
        if loadedCheckpoint?.uploadSessionBytes == bytes { loadedCheckpoint = nil }
        return Self.empty()
    }

    private func loadCheckpoint(
        _ effect: CoreEffect
    ) throws -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        let fields = effect.packet.fields
        let uploadSessionBytes = try fields.v2RequiredBytes(EncryptedUploadV2Abi.fieldUploadSessionUUID)
        guard let uploadSessionID = UUID(v2Bytes: uploadSessionBytes) else {
            throw Self.failure(code: 1, detail: "upload session UUID is invalid")
        }
        let url = Self.checkpointURL(uploadSessionID: uploadSessionID, rootDirectory: rootDirectory)
        guard FileManager.default.fileExists(atPath: url.path) else {
            loadedCheckpoint = nil
            return Self.single(.init(kind: EncryptedUploadV2Abi.eventCheckpointLoaded))
        }
        let resourceValues = try url.resourceValues(forKeys: [.fileSizeKey])
        guard let fileSize = resourceValues.fileSize,
              fileSize <= Self.maximumCheckpointSidecarBytes
        else {
            throw Self.failure(code: 1, detail: "persisted encrypted upload v2 checkpoint is oversized")
        }
        let value = try JSONDecoder().decode(
            PersistedEncryptedUploadV2Checkpoint.self,
            from: Data(contentsOf: url)
        )
        let serialNumber = try fields.v2RequiredText(EncryptedUploadV2Abi.fieldSerialNumber)
        let recordingUUID = try fields.v2RequiredText(EncryptedUploadV2Abi.fieldRecordingUUID)
        let recordingGeneration = try fields.v2RequiredUInt32(EncryptedUploadV2Abi.fieldRecordingGeneration)
        let ownerRevision = try fields.v2RequiredUInt32(EncryptedUploadV2Abi.fieldOwnerRevision)
        guard value.serialNumber == serialNumber,
              value.recordingUUID == recordingUUID,
              value.recordingGeneration == recordingGeneration,
              value.uploadSessionBytes == uploadSessionBytes,
              value.ownerRevision == ownerRevision
        else {
            throw Self.failure(code: 11, detail: "persisted encrypted upload v2 checkpoint identity is stale")
        }
        loadedCheckpoint = value
        return Self.single(.init(
            kind: EncryptedUploadV2Abi.eventCheckpointLoaded,
            fields: [.bytes(id: EncryptedUploadV2Abi.fieldCheckpoint, value: value.coreCheckpoint)]
        ))
    }

    private func truncateSink(
        _ effect: CoreEffect
    ) throws -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        let sinkID = try effect.packet.fields.v2RequiredText(EncryptedUploadV2Abi.fieldSinkID)
        guard UUID(uuidString: sinkID) != nil else {
            throw Self.failure(code: 1, detail: "encrypted upload v2 sink ID is invalid")
        }
        let nextOffset = try effect.packet.fields.v2RequiredUnsigned(EncryptedUploadV2Abi.fieldOffset)
        if let loadedCheckpoint {
            guard loadedCheckpoint.sinkID == sinkID,
                  loadedCheckpoint.nextCiphertextOffset == nextOffset
            else {
                throw Self.failure(code: 11, detail: "sink truncation does not match the loaded checkpoint")
            }
        } else if nextOffset != 0 {
            throw Self.failure(code: 11, detail: "nonzero sink truncation requires a loaded checkpoint")
        }
        let fileURL = rootDirectory.appendingPathComponent(sinkID)
            .appendingPathExtension("encrypted-upload-v2")
        if FileManager.default.fileExists(atPath: fileURL.path) {
            let handle = try FileHandle(forWritingTo: fileURL)
            defer { try? handle.close() }
            try handle.truncate(atOffset: nextOffset)
            try handle.synchronize()
        }
        return Self.single(.init(kind: EncryptedUploadV2Abi.eventSinkTruncated))
    }

    private func repairWindow(
        _ effect: CoreEffect
    ) async throws -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        guard let activeTransfer, !pendingMissingSequences.isEmpty else {
            throw Self.failure(code: 9, detail: "there is no repairable encrypted upload v2 window")
        }
        let operationGeneration = generation
        let transportSessionID = activeTransfer.context.transportSessionID
        let missingSequences = try Self.decodeMissingSequences(
            effect.packet.fields.v2RequiredBytes(EncryptedUploadV2Abi.fieldMissingSequence)
        )
        guard missingSequences == pendingMissingSequences else {
            throw Self.failure(code: 11, detail: "repair request does not match the staged missing sequences")
        }
        let frame = try await activeTransfer.receiver.repairAcknowledgement(
            missingSequences: missingSequences
        )
        try validateActiveOperation(
            generation: operationGeneration,
            transportSessionID: transportSessionID
        )
        try await activeTransfer.reader.resume()
        try validateActiveOperation(
            generation: operationGeneration,
            transportSessionID: transportSessionID
        )
        try await sendControl(frame)
        try validateActiveOperation(
            generation: operationGeneration,
            transportSessionID: transportSessionID
        )
        let pair = AsyncThrowingStream<CoreHostEventPayload, Error>.makeStream()
        pumpTask = Task {
            await self.pumpRepair(pair.continuation, generation: operationGeneration)
        }
        return pair.stream
    }

    private func pumpRepair(
        _ continuation: AsyncThrowingStream<CoreHostEventPayload, Error>.Continuation,
        generation pumpGeneration: UInt64
    ) async {
        do {
            try Task.checkCancellation()
            guard generation == pumpGeneration else {
                continuation.finish()
                return
            }
            guard let activeTransfer else {
                throw Self.failure(code: 9, detail: "encrypted upload v2 transfer state is missing")
            }
            while let rawValue = try await activeTransfer.reader.next() {
                let event = try await activeTransfer.receiver.receive(rawValue)
                guard generation == pumpGeneration else {
                    continuation.finish()
                    return
                }
                guard let event else { continue }
                guard case let .windowStaged(value) = event else {
                    throw Self.failure(code: 9, detail: "encrypted upload v2 repair reached EOF unexpectedly")
                }
                try await activeTransfer.reader.pause()
                guard generation == pumpGeneration else {
                    continuation.finish()
                    return
                }
                pendingCheckpoint = value.checkpoint
                pendingMissingSequences = value.missingSequences
                continuation.yield(Self.windowStaged(context: activeTransfer.context, value: value))
                continuation.finish()
                pumpTask = nil
                return
            }
            throw Self.failure(code: 9, detail: "encrypted transfer stream ended during repair")
        } catch {
            guard generation == pumpGeneration else {
                continuation.finish()
                return
            }
            if let activeTransfer { await activeTransfer.reader.cancel() }
            self.activeTransfer = nil
            startContinuation?.finish()
            startContinuation = nil
            pumpTask = nil
            continuation.finish(throwing: error)
        }
    }

    private func start(
        _ effect: CoreEffect
    ) async throws -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        guard activeTransfer == nil,
              openingTransportSessionID == nil,
              retainedTransportSessionID == nil
        else {
            throw Self.failure(
                code: 8,
                detail: "another encrypted upload v2 transfer is active"
            )
        }
        let context = try Self.context(effect.packet.fields)
        let coreCheckpoint = effect.packet.fields.v2OptionalBytes(EncryptedUploadV2Abi.fieldCheckpoint)
        let checkpoint: EncryptedUploadV2CheckpointValue
        if let coreCheckpoint {
            guard let loadedCheckpoint,
                  loadedCheckpoint.coreCheckpoint == coreCheckpoint,
                  loadedCheckpoint.matches(context)
            else {
                throw Self.failure(code: 11, detail: "START resume checkpoint does not match durable native state")
            }
            checkpoint = loadedCheckpoint.nativeCheckpoint
        } else {
            checkpoint = EncryptedUploadV2CheckpointValue(
                revision: 0,
                nextCiphertextOffset: 0,
                prefixSHA256: Data(SHA256.hash(data: Data()))
            )
        }
        let receiver = try EncryptedUploadV2TransferReceiver(
            rootDirectory: rootDirectory,
            sinkID: context.sinkID,
            transportSessionID: context.transportSessionID,
            expectedCiphertextLength: context.ciphertextLength,
            expectedCiphertextSHA256: context.ciphertextSHA256,
            maximumDataPayloadBytes: context.dataPayloadBytes,
            maximumWindowPackets: context.windowPackets,
            maximumMissingSequences: context.maximumMissingSequences,
            checkpoint: checkpoint,
            mapper: mapper
        )
        generation &+= 1
        let startGeneration = generation
        openingTransportSessionID = context.transportSessionID
        do {
            try await receiver.prepare()
        } catch {
            if generation == startGeneration {
                openingTransportSessionID = nil
            }
            throw error
        }
        guard generation == startGeneration,
              openingTransportSessionID == context.transportSessionID
        else {
            throw Self.failure(code: 16, detail: "encrypted upload v2 transfer opening was cancelled")
        }
        let request = EncryptedUploadV2StartRequestValue(
            transportSessionID: context.transportSessionID,
            uploadSessionID: context.uploadSessionID,
            recordingUUID: context.recordingUUID,
            recordingGeneration: context.recordingGeneration,
            authorizationSHA256: context.authorizationSHA256,
            expectedCiphertextLength: context.ciphertextLength,
            expectedCiphertextSHA256: context.ciphertextSHA256,
            expectedCheckpointIntervalBlocks: context.checkpointIntervalBlocks,
            checkpointRevision: checkpoint.revision,
            nextCiphertextOffset: checkpoint.nextCiphertextOffset,
            prefixSHA256: checkpoint.prefixSHA256,
            windowPackets: context.windowPackets,
            dataPayloadBytes: context.dataPayloadBytes
        )
        let task = Task {
            try await openTransfer(request, coreCheckpoint == nil ? nil : checkpoint)
        }
        openingTask = task
        let opened: EncryptedUploadV2TransferOpenResult
        do {
            opened = try await task.value
        } catch {
            if generation == startGeneration {
                openingTransportSessionID = nil
                openingTask = nil
            }
            throw error
        }
        guard generation == startGeneration,
              openingTransportSessionID == context.transportSessionID
        else {
            throw Self.failure(code: 16, detail: "encrypted upload v2 transfer opening was cancelled")
        }
        openingTransportSessionID = nil
        openingTask = nil
        guard case let .opened(notifications) = opened else {
            return AsyncThrowingStream { continuation in
                continuation.yield(.init(kind: EncryptedUploadV2Abi.eventResumeRejected))
                continuation.finish()
            }
        }
        retainedTransportSessionID = context.transportSessionID
        let reader = EncryptedUploadV2NotificationReader(
            notifications,
            maximumBufferedBytes: Self.maximumNotificationBufferBytes,
            maximumBufferedEvents: min(Int(context.windowPackets) + 582, 4_096)
        )
        activeTransfer = ActiveTransfer(
            context: context,
            receiver: receiver,
            reader: reader
        )
        await reader.start()
        guard generation == startGeneration,
              retainedTransportSessionID == context.transportSessionID,
              activeTransfer?.context.transportSessionID == context.transportSessionID
        else {
            await reader.cancel()
            throw Self.failure(code: 16, detail: "encrypted upload v2 transfer opening was cancelled")
        }
        let pair = AsyncThrowingStream<CoreHostEventPayload, Error>.makeStream()
        startContinuation = pair.continuation
        pumpTask = Task {
            await self.pumpStart(
                pair.continuation,
                includeStarted: true,
                generation: startGeneration
            )
        }
        return pair.stream
    }

    private func saveCheckpoint(
        _ effect: CoreEffect
    ) async throws -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        guard let activeTransfer,
              let pendingCheckpoint,
              pendingMissingSequences.isEmpty
        else {
            throw Self.failure(code: 9, detail: "there is no staged encrypted upload v2 window")
        }
        let operationGeneration = generation
        let transportSessionID = activeTransfer.context.transportSessionID
        let coreCheckpoint = try effect.packet.fields.v2RequiredBytes(EncryptedUploadV2Abi.fieldCheckpoint)
        let persisted = try persist(
            coreCheckpoint: coreCheckpoint,
            nativeCheckpoint: pendingCheckpoint,
            context: activeTransfer.context,
            rootDirectory: rootDirectory
        )
        try await activeTransfer.receiver.checkpointDidPersist(pendingCheckpoint)
        try validateActiveOperation(
            generation: operationGeneration,
            transportSessionID: transportSessionID
        )
        loadedCheckpoint = persisted
        persistedCoreCheckpoint = coreCheckpoint
        return Self.single(.init(kind: EncryptedUploadV2Abi.eventCheckpointSaved))
    }

    private func acknowledgeWindow(
        _ effect: CoreEffect
    ) async throws -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        guard let activeTransfer,
              let pendingCheckpoint,
              let startContinuation
        else {
            throw Self.failure(code: 9, detail: "there is no persisted encrypted upload v2 window")
        }
        let operationGeneration = generation
        let transportSessionID = activeTransfer.context.transportSessionID
        let coreCheckpoint = try effect.packet.fields.v2RequiredBytes(EncryptedUploadV2Abi.fieldCheckpoint)
        guard coreCheckpoint == persistedCoreCheckpoint else {
            throw Self.failure(code: 11, detail: "window acknowledgement checkpoint does not match persisted state")
        }
        let frame = try await activeTransfer.receiver.windowAcknowledgement(for: pendingCheckpoint)
        try validateActiveOperation(
            generation: operationGeneration,
            transportSessionID: transportSessionID
        )
        try await activeTransfer.reader.resume()
        try validateActiveOperation(
            generation: operationGeneration,
            transportSessionID: transportSessionID
        )
        try await sendControl(frame)
        try validateActiveOperation(
            generation: operationGeneration,
            transportSessionID: transportSessionID
        )
        self.pendingCheckpoint = nil
        pendingMissingSequences = []
        persistedCoreCheckpoint = nil
        self.startContinuation = nil
        pumpTask = Task {
            await self.pumpStart(
                startContinuation,
                includeStarted: false,
                generation: operationGeneration
            )
        }
        return Self.single(.init(
            kind: EncryptedUploadV2Abi.eventWindowAcknowledged,
            fields: [.bytes(id: EncryptedUploadV2Abi.fieldCheckpoint, value: coreCheckpoint)]
        ))
    }

    private func validateActiveOperation(
        generation expectedGeneration: UInt64,
        transportSessionID: UInt64
    ) throws {
        guard generation == expectedGeneration,
              retainedTransportSessionID == transportSessionID,
              activeTransfer?.context.transportSessionID == transportSessionID
        else {
            throw Self.failure(code: 16, detail: "encrypted upload v2 transfer operation was cancelled")
        }
    }

    private func pumpStart(
        _ continuation: AsyncThrowingStream<CoreHostEventPayload, Error>.Continuation,
        includeStarted: Bool,
        generation pumpGeneration: UInt64
    ) async {
        do {
            try Task.checkCancellation()
            guard generation == pumpGeneration else {
                continuation.finish()
                return
            }
            if includeStarted {
                continuation.yield(.init(kind: EncryptedUploadV2Abi.eventTransferStarted))
            }
            guard let activeTransfer else {
                throw Self.failure(code: 9, detail: "encrypted upload v2 transfer state is missing")
            }
            while let rawValue = try await activeTransfer.reader.next() {
                let event = try await activeTransfer.receiver.receive(rawValue)
                guard generation == pumpGeneration else {
                    continuation.finish()
                    return
                }
                guard let event else { continue }
                switch event {
                case let .windowStaged(value):
                    try await activeTransfer.reader.pause()
                    guard generation == pumpGeneration else {
                        continuation.finish()
                        return
                    }
                    pendingCheckpoint = value.checkpoint
                    pendingMissingSequences = value.missingSequences
                    startContinuation = continuation
                    continuation.yield(Self.windowStaged(context: activeTransfer.context, value: value))
                    pumpTask = nil
                    return
                case let .completed(value):
                    try await activeTransfer.reader.pause()
                    guard generation == pumpGeneration else {
                        continuation.finish()
                        return
                    }
                    continuation.yield(Self.transferCompleted(value.evidence))
                    continuation.finish()
                    startContinuation = nil
                    pumpTask = nil
                    return
                }
            }
            throw Self.failure(code: 9, detail: "encrypted transfer stream ended before EOF")
        } catch {
            guard generation == pumpGeneration else {
                continuation.finish()
                return
            }
            if let activeTransfer { await activeTransfer.reader.cancel() }
            activeTransfer = nil
            startContinuation = nil
            pumpTask = nil
            continuation.finish(throwing: error)
        }
    }

    func waitUntilNotificationObserved(count: Int) async {
        await activeTransfer?.reader.waitUntilObserved(count: count)
    }

    private func persist(
        coreCheckpoint: Data,
        nativeCheckpoint: EncryptedUploadV2CheckpointValue,
        context: Context,
        rootDirectory: URL
    ) throws -> PersistedEncryptedUploadV2Checkpoint {
        let directory = rootDirectory.appendingPathComponent("Checkpoints", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let value = PersistedEncryptedUploadV2Checkpoint(
            coreCheckpoint: coreCheckpoint,
            serialNumber: context.serialNumber,
            recordingUUID: context.recordingUUID,
            recordingGeneration: context.recordingGeneration,
            uploadSessionBytes: context.uploadSessionBytes,
            ownerRevision: context.ownerRevision,
            transportSessionID: context.transportSessionID,
            sinkID: context.sinkID,
            windowPackets: context.windowPackets,
            dataPayloadBytes: context.dataPayloadBytes,
            revision: nativeCheckpoint.revision,
            nextCiphertextOffset: nativeCheckpoint.nextCiphertextOffset,
            prefixSHA256: nativeCheckpoint.prefixSHA256,
            highestContiguousSequence: nativeCheckpoint.highestContiguousSequence
        )
        let url = directory.appendingPathComponent(context.uploadSessionID.uuidString).appendingPathExtension("json")
        try checkpointStore.replace(JSONEncoder().encode(value), at: url)
        return value
    }

    private static func checkpointURL(uploadSessionID: UUID, rootDirectory: URL) -> URL {
        rootDirectory.appendingPathComponent("Checkpoints", isDirectory: true)
            .appendingPathComponent(uploadSessionID.uuidString)
            .appendingPathExtension("json")
    }

    private static func windowStaged(
        context: Context,
        value: EncryptedUploadV2WindowStageValue
    ) -> CoreHostEventPayload {
        .init(kind: EncryptedUploadV2Abi.eventWindowStaged, fields: [
            .text(id: EncryptedUploadV2Abi.fieldSerialNumber, value: context.serialNumber),
            .text(id: EncryptedUploadV2Abi.fieldRecordingUUID, value: context.recordingUUID),
            .unsigned(id: EncryptedUploadV2Abi.fieldRecordingGeneration, value: UInt64(context.recordingGeneration)),
            .bytes(id: EncryptedUploadV2Abi.fieldUploadSessionUUID, value: context.uploadSessionBytes),
            .unsigned(id: EncryptedUploadV2Abi.fieldOwnerRevision, value: UInt64(context.ownerRevision)),
            .unsigned(id: EncryptedUploadV2Abi.fieldTransportSessionID, value: context.transportSessionID),
            .unsigned(id: EncryptedUploadV2Abi.fieldCheckpointRevision, value: UInt64(value.checkpoint.revision)),
            .unsigned(id: EncryptedUploadV2Abi.fieldOffset, value: value.checkpoint.nextCiphertextOffset),
            .bytes(id: EncryptedUploadV2Abi.fieldPrefixSHA256, value: value.checkpoint.prefixSHA256),
            .unsigned(id: EncryptedUploadV2Abi.fieldWindowPackets, value: UInt64(context.windowPackets)),
            .unsigned(id: EncryptedUploadV2Abi.fieldDataPayloadBytes, value: UInt64(context.dataPayloadBytes)),
            .bytes(id: EncryptedUploadV2Abi.fieldMissingSequence, value: Self.missingSequenceBytes(value.missingSequences)),
        ])
    }

    private static func transferCompleted(
        _ evidence: EncryptedUploadV2TransferEvidence
    ) -> CoreHostEventPayload {
        .init(kind: EncryptedUploadV2Abi.eventTransferCompleted, fields: [
            .unsigned(id: EncryptedUploadV2Abi.fieldCiphertextLength, value: evidence.ciphertextLength),
            .bytes(id: EncryptedUploadV2Abi.fieldCiphertextSHA256, value: evidence.ciphertextSHA256),
            .unsigned(id: EncryptedUploadV2Abi.fieldManifestLength, value: UInt64(evidence.manifestLength)),
            .bytes(id: EncryptedUploadV2Abi.fieldManifestSHA256, value: evidence.manifestSHA256),
            .unsigned(id: EncryptedUploadV2Abi.fieldBlockCount, value: UInt64(evidence.blockCount)),
        ])
    }

    private static func context(_ fields: [CoreField]) throws -> Context {
        let uploadSessionBytes = try fields.v2RequiredBytes(EncryptedUploadV2Abi.fieldUploadSessionUUID)
        guard uploadSessionBytes.count == 16,
              let uploadSessionID = UUID(v2Bytes: uploadSessionBytes)
        else {
            throw failure(code: 1, detail: "upload session UUID is invalid")
        }
        return Context(
            serialNumber: try fields.v2RequiredText(EncryptedUploadV2Abi.fieldSerialNumber),
            recordingUUID: try fields.v2RequiredText(EncryptedUploadV2Abi.fieldRecordingUUID),
            recordingGeneration: try fields.v2RequiredUInt32(EncryptedUploadV2Abi.fieldRecordingGeneration),
            uploadSessionID: uploadSessionID,
            uploadSessionBytes: uploadSessionBytes,
            ownerRevision: try fields.v2RequiredUInt32(EncryptedUploadV2Abi.fieldOwnerRevision),
            transportSessionID: try fields.v2RequiredUnsigned(EncryptedUploadV2Abi.fieldTransportSessionID),
            sinkID: try fields.v2RequiredText(EncryptedUploadV2Abi.fieldSinkID),
            windowPackets: try fields.v2RequiredUInt16(EncryptedUploadV2Abi.fieldWindowPackets),
            dataPayloadBytes: try fields.v2RequiredUInt16(EncryptedUploadV2Abi.fieldDataPayloadBytes),
            checkpointIntervalBlocks: try fields.v2RequiredUInt32(EncryptedUploadV2Abi.fieldCheckpointInterval),
            maximumDataPayloadBytes: try fields.v2RequiredUInt16(EncryptedUploadV2Abi.fieldMaximumDataPayloadBytes),
            maximumWindowPackets: try fields.v2RequiredUInt16(EncryptedUploadV2Abi.fieldMaximumWindowPackets),
            maximumMissingSequences: try fields.v2RequiredUInt16(EncryptedUploadV2Abi.fieldMaximumMissingSequences),
            ciphertextLength: try fields.v2RequiredUnsigned(EncryptedUploadV2Abi.fieldCiphertextLength),
            ciphertextSHA256: try fields.v2RequiredDigest(EncryptedUploadV2Abi.fieldCiphertextSHA256),
            authorizationSHA256: try fields.v2RequiredDigest(EncryptedUploadV2Abi.fieldAuthorizationSHA256)
        )
    }

    private static func missingSequenceBytes(_ values: [UInt32]) -> Data {
        var data = Data(capacity: values.count * 4)
        for value in values {
            var littleEndian = value.littleEndian
            Swift.withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
        }
        return data
    }

    private static func decodeMissingSequences(_ data: Data) throws -> [UInt32] {
        guard data.count.isMultiple(of: 4) else {
            throw failure(code: 1, detail: "missing-sequence field is malformed")
        }
        return stride(from: 0, to: data.count, by: 4).map { offset in
            data[offset..<(offset + 4)].enumerated().reduce(0) { value, pair in
                value | (UInt32(pair.element) << UInt32(pair.offset * 8))
            }
        }
    }

    private static func readUInt64(_ data: Data, at offset: Int) -> UInt64 {
        data[offset..<(offset + 8)].enumerated().reduce(0) { value, pair in
            value | (UInt64(pair.element) << UInt64(pair.offset * 8))
        }
    }

    private static func failedStream(
        _ detail: String
    ) -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        AsyncThrowingStream { $0.finish(throwing: failure(code: 7, detail: detail)) }
    }

    private static func single(
        _ value: CoreHostEventPayload
    ) -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(value)
            continuation.finish()
        }
    }

    private static func empty() -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        AsyncThrowingStream { $0.finish() }
    }

    private static func failure(code: UInt32, detail: String) -> EncryptedUploadV2HostFailure {
        EncryptedUploadV2HostFailure(
            errorCode: code,
            retryable: false,
            detail: detail
        )
    }

    private static let maximumNotificationBufferBytes = 1_048_576
    private static let maximumCheckpointSidecarBytes = 65_536
}

struct EncryptedUploadV2DurableFileStore: Sendable {
    typealias DirectorySync = @Sendable (URL) throws -> Void

    private let syncDirectory: DirectorySync

    init(
        syncDirectory: @escaping DirectorySync = Self.syncDirectory
    ) {
        self.syncDirectory = syncDirectory
    }

    func replace(_ data: Data, at url: URL) throws {
        let fileManager = FileManager.default
        let directory = url.deletingLastPathComponent()
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        try syncDirectory(directory.deletingLastPathComponent())
        let temporaryURL = directory.appendingPathComponent(".\(UUID().uuidString).tmp")
        guard fileManager.createFile(atPath: temporaryURL.path, contents: nil) else {
            throw POSIXError(.EIO)
        }
        do {
            let handle = try FileHandle(forWritingTo: temporaryURL)
            do {
                try handle.write(contentsOf: data)
#if os(iOS)
                try fileManager.setAttributes(
                    [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                    ofItemAtPath: temporaryURL.path
                )
#endif
                try handle.synchronize()
                try handle.close()
            } catch {
                try? handle.close()
                throw error
            }
            try Self.rename(temporaryURL, to: url)
            try syncDirectory(directory)
        } catch {
            try? fileManager.removeItem(at: temporaryURL)
            throw error
        }
    }

    func removeIfPresent(_ url: URL) throws {
        let fileManager = FileManager.default
        let directory = url.deletingLastPathComponent()
        if fileManager.fileExists(atPath: url.path) {
            try fileManager.removeItem(at: url)
        } else if !fileManager.fileExists(atPath: directory.path) {
            return
        }
        try syncDirectory(directory)
    }

    private static func rename(_ source: URL, to destination: URL) throws {
        let result = source.path.withCString { sourcePath in
            destination.path.withCString { destinationPath in
                Darwin.rename(sourcePath, destinationPath)
            }
        }
        guard result == 0 else { throw Self.posixError() }
    }

    private static func syncDirectory(_ directory: URL) throws {
        let descriptor = directory.path.withCString { Darwin.open($0, O_RDONLY) }
        guard descriptor >= 0 else { throw posixError() }
        defer { _ = Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else { throw posixError() }
    }

    private static func posixError() -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}

private struct PersistedEncryptedUploadV2Checkpoint: Codable, Sendable {
    let coreCheckpoint: Data
    let serialNumber: String
    let recordingUUID: String
    let recordingGeneration: UInt32
    let uploadSessionBytes: Data
    let ownerRevision: UInt32
    let transportSessionID: UInt64
    let sinkID: String
    let windowPackets: UInt16
    let dataPayloadBytes: UInt16
    let revision: UInt32
    let nextCiphertextOffset: UInt64
    let prefixSHA256: Data
    let highestContiguousSequence: UInt32?

    var nativeCheckpoint: EncryptedUploadV2CheckpointValue {
        .init(
            revision: revision,
            nextCiphertextOffset: nextCiphertextOffset,
            prefixSHA256: prefixSHA256,
            highestContiguousSequence: highestContiguousSequence
        )
    }

    func matches(_ context: EncryptedUploadV2TransferHost.Context) -> Bool {
        serialNumber == context.serialNumber
            && recordingUUID == context.recordingUUID
            && recordingGeneration == context.recordingGeneration
            && uploadSessionBytes == context.uploadSessionBytes
            && ownerRevision == context.ownerRevision
            && transportSessionID == context.transportSessionID
            && sinkID == context.sinkID
            && windowPackets == context.windowPackets
            && dataPayloadBytes == context.dataPayloadBytes
    }
}

enum EncryptedUploadV2NotificationReaderError: Error, Equatable, Sendable {
    case bufferLimitExceeded
    case invalidPayload
    case payloadWhilePaused
    case cancelled
}

actor EncryptedUploadV2NotificationReader {
    private enum Event: @unchecked Sendable {
        case value(Data)
        case finished
        case failed(Error)
    }

    private let stream: AsyncThrowingStream<Data, Error>
    private let maximumBufferedBytes: Int
    private let maximumBufferedEvents: Int
    private var buffered: [Event] = []
    private var bufferedBytes = 0
    private var waiter: CheckedContinuation<Event, Never>?
    private var collectionTask: Task<Void, Never>?
    private var paused = false
    private var terminal: Event?
    private var observedCount = 0
    private var observedWaiters: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []

    init(
        _ stream: AsyncThrowingStream<Data, Error>,
        maximumBufferedBytes: Int,
        maximumBufferedEvents: Int
    ) {
        precondition(maximumBufferedBytes > 0 && maximumBufferedEvents > 0)
        self.stream = stream
        self.maximumBufferedBytes = maximumBufferedBytes
        self.maximumBufferedEvents = maximumBufferedEvents
    }

    func start() {
        guard collectionTask == nil, terminal == nil else { return }
        collectionTask = Task { [stream] in
            do {
                for try await value in stream {
                    guard self.push(.value(value)) else { return }
                }
                _ = self.push(.finished)
            } catch {
                _ = self.push(.failed(error))
            }
        }
    }

    func next() async throws -> Data? {
        guard !paused else {
            throw EncryptedUploadV2NotificationReaderError.payloadWhilePaused
        }
        let event: Event
        if !buffered.isEmpty {
            event = buffered.removeFirst()
            if case let .value(value) = event { bufferedBytes -= value.count }
        } else if let terminal {
            event = terminal
        } else {
            event = await withCheckedContinuation { waiter = $0 }
        }
        switch event {
        case let .value(value): return value
        case .finished: return nil
        case let .failed(error): throw error
        }
    }

    func pause() throws {
        if let terminal { try Self.resolve(terminal) }
        if !buffered.isEmpty {
            fail(EncryptedUploadV2NotificationReaderError.payloadWhilePaused)
            throw EncryptedUploadV2NotificationReaderError.payloadWhilePaused
        }
        paused = true
    }

    func resume() throws {
        if let terminal { try Self.resolve(terminal) }
        paused = false
    }

    func cancel() {
        collectionTask?.cancel()
        collectionTask = nil
        fail(EncryptedUploadV2NotificationReaderError.cancelled)
    }

    func waitUntilObserved(count: Int) async {
        if observedCount >= count { return }
        await withCheckedContinuation { observedWaiters.append((count, $0)) }
    }

    @discardableResult
    private func push(_ event: Event) -> Bool {
        guard terminal == nil else { return false }
        if case let .value(value) = event {
            observedCount += 1
            let ready = observedWaiters.filter { observedCount >= $0.count }
            observedWaiters.removeAll { observedCount >= $0.count }
            for waiter in ready { waiter.continuation.resume() }
            guard !value.isEmpty else {
                fail(EncryptedUploadV2NotificationReaderError.invalidPayload)
                return false
            }
            let (nextBytes, overflow) = bufferedBytes.addingReportingOverflow(value.count)
            guard !paused else {
                fail(EncryptedUploadV2NotificationReaderError.payloadWhilePaused)
                return false
            }
            guard !overflow,
                  nextBytes <= maximumBufferedBytes,
                  waiter != nil || buffered.count < maximumBufferedEvents
            else {
                fail(EncryptedUploadV2NotificationReaderError.bufferLimitExceeded)
                return false
            }
        }
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: event)
        } else {
            switch event {
            case let .value(value):
                bufferedBytes += value.count
                buffered.append(event)
            case .finished, .failed:
                terminal = event
            }
        }
        return true
    }

    private func fail(_ error: Error) {
        guard terminal == nil else { return }
        let event = Event.failed(error)
        terminal = event
        buffered.removeAll(keepingCapacity: false)
        bufferedBytes = 0
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: event)
        }
    }

    private static func resolve(_ event: Event) throws {
        switch event {
        case .value: return
        case .finished: throw EncryptedUploadV2NotificationReaderError.cancelled
        case let .failed(error): throw error
        }
    }
}

private extension Array where Element == CoreField {
    func v2RequiredUnsigned(_ id: UInt32) throws -> UInt64 {
        for field in self {
            if case let .unsigned(fieldID, value) = field, fieldID == id { return value }
        }
        throw EncryptedUploadV2HostFailure(errorCode: 1, retryable: false, detail: "missing field \(id)")
    }

    func v2RequiredUInt16(_ id: UInt32) throws -> UInt16 {
        guard let value = UInt16(exactly: try v2RequiredUnsigned(id)) else {
            throw EncryptedUploadV2HostFailure(errorCode: 1, retryable: false, detail: "field \(id) exceeds 16 bits")
        }
        return value
    }

    func v2RequiredUInt32(_ id: UInt32) throws -> UInt32 {
        guard let value = UInt32(exactly: try v2RequiredUnsigned(id)) else {
            throw EncryptedUploadV2HostFailure(errorCode: 1, retryable: false, detail: "field \(id) exceeds 32 bits")
        }
        return value
    }

    func v2RequiredText(_ id: UInt32) throws -> String {
        for field in self {
            if case let .text(fieldID, value) = field, fieldID == id { return value }
        }
        throw EncryptedUploadV2HostFailure(errorCode: 1, retryable: false, detail: "missing field \(id)")
    }

    func v2RequiredBytes(_ id: UInt32) throws -> Data {
        for field in self {
            if case let .bytes(fieldID, value) = field, fieldID == id { return value }
        }
        throw EncryptedUploadV2HostFailure(errorCode: 1, retryable: false, detail: "missing field \(id)")
    }

    func v2OptionalBytes(_ id: UInt32) -> Data? {
        for field in self {
            if case let .bytes(fieldID, value) = field, fieldID == id { return value }
        }
        return nil
    }

    func v2RequiredDigest(_ id: UInt32) throws -> Data {
        let value = try v2RequiredBytes(id)
        guard value.count == 32 else {
            throw EncryptedUploadV2HostFailure(errorCode: 1, retryable: false, detail: "field \(id) is not a SHA-256 digest")
        }
        return value
    }
}

private extension UUID {
    init?(v2Bytes: Data) {
        guard v2Bytes.count == 16 else { return nil }
        let bytes = Array(v2Bytes)
        self.init(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11],
            bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }
}
