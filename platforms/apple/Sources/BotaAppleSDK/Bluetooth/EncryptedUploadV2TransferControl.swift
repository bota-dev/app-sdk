import Foundation

actor EncryptedUploadV2TransferControl {
    typealias Subscribe = @Sendable (String) async throws -> AsyncThrowingStream<Data, Error>
    typealias Write = @Sendable (String, Data) async throws -> Void
    typealias Unsubscribe = @Sendable (String) async throws -> Void

    private static let startMessageType: UInt8 = 0x20
    private static let resumeRequestMessageType: UInt8 = 0x22
    private static let cleanupAbortReason: UInt16 = 0x00FF
    private static let defaultReplyTimeoutNanoseconds: UInt64 = 10_000_000_000
    private static let defaultCleanupTimeoutNanoseconds: UInt64 = 1_000_000_000

    private let mapper: CoreModelMapper
    private let subscribe: Subscribe
    private let write: Write
    private let unsubscribe: Unsubscribe
    private var exchangeActive = false
    private var activeTransfer: ActiveEncryptedUploadV2Transfer?
    private var cleanupUncertain = false

    init(
        mapper: CoreModelMapper,
        subscribe: @escaping Subscribe,
        write: @escaping Write,
        unsubscribe: @escaping Unsubscribe
    ) {
        self.mapper = mapper
        self.subscribe = subscribe
        self.write = write
        self.unsubscribe = unsubscribe
    }

    init(bluetooth: CoreBluetoothHost, mapper: CoreModelMapper) {
        self.init(
            mapper: mapper,
            subscribe: { peripheralID in
                try await bluetooth.subscribe(
                    peripheralID: peripheralID,
                    serviceUUID: BotaBluetoothUUIDs.storageService,
                    characteristicUUID: BotaBluetoothUUIDs.recordingTransferV2
                )
            },
            write: { peripheralID, data in
                try await bluetooth.write(
                    peripheralID: peripheralID,
                    serviceUUID: BotaBluetoothUUIDs.storageService,
                    characteristicUUID: BotaBluetoothUUIDs.transferControlV2,
                    data: data
                )
            },
            unsubscribe: { peripheralID in
                try await bluetooth.unsubscribe(
                    peripheralID: peripheralID,
                    serviceUUID: BotaBluetoothUUIDs.storageService,
                    characteristicUUID: BotaBluetoothUUIDs.recordingTransferV2
                )
            }
        )
    }

    func start(
        peripheralID: String,
        request: EncryptedUploadV2StartRequestValue,
        replyTimeoutNanoseconds: UInt64 = defaultReplyTimeoutNanoseconds,
        cleanupTimeoutNanoseconds: UInt64 = defaultCleanupTimeoutNanoseconds
    ) async throws -> EncryptedUploadV2StartAcknowledgementValue {
        let frame = try mapper.createEncryptedUploadV2Start(
            transportSessionID: request.transportSessionID,
            uploadSessionID: request.uploadSessionID,
            recordingUUID: request.recordingUUID,
            recordingGeneration: request.recordingGeneration,
            authorizationSHA256: request.authorizationSHA256,
            checkpointRevision: request.checkpointRevision,
            nextCiphertextOffset: request.nextCiphertextOffset,
            prefixSHA256: request.prefixSHA256,
            windowPackets: request.windowPackets,
            dataPayloadBytes: request.dataPayloadBytes
        )
        let terminal: MatchedTransferControlReply<EncryptedUploadV2StartAcknowledgementValue> = try await exchange(
            peripheralID: peripheralID,
            frame: frame,
            transportSessionID: request.transportSessionID,
            failedMessageType: Self.startMessageType,
            replyTimeoutNanoseconds: replyTimeoutNanoseconds,
            cleanupTimeoutNanoseconds: cleanupTimeoutNanoseconds,
            retainSubscription: { _ in true }
        ) { value in
            guard case let .startAccepted(acknowledgement) = value else { return nil }
            guard acknowledgement.uploadSessionID == request.uploadSessionID,
                  Self.sameUUID(acknowledgement.recordingUUID, request.recordingUUID),
                  acknowledgement.recordingGeneration == request.recordingGeneration,
                  acknowledgement.ciphertextLength == request.expectedCiphertextLength,
                  acknowledgement.ciphertextSHA256 == request.expectedCiphertextSHA256,
                  acknowledgement.windowPackets == request.windowPackets,
                  acknowledgement.dataPayloadBytes == request.dataPayloadBytes,
                  acknowledgement.checkpointIntervalBlocks == request.expectedCheckpointIntervalBlocks,
                  acknowledgement.checkpointRevision == request.checkpointRevision,
                  acknowledgement.nextCiphertextOffset == request.nextCiphertextOffset,
                  acknowledgement.prefixSHA256 == request.prefixSHA256
            else {
                throw Self.error(
                    code: .identityMismatch,
                    detail: "START_ACK does not match the requested recording, ciphertext, or checkpoint"
                )
            }
            return acknowledgement
        }
        switch terminal {
        case let .value(acknowledgement):
            return acknowledgement
        case let .deviceError(error):
            throw Self.deviceRejection(error)
        }
    }

    func resume(
        peripheralID: String,
        request: EncryptedUploadV2ResumeRequestValue,
        replyTimeoutNanoseconds: UInt64 = defaultReplyTimeoutNanoseconds,
        cleanupTimeoutNanoseconds: UInt64 = defaultCleanupTimeoutNanoseconds
    ) async throws -> EncryptedUploadV2ResumeDecision {
        let frame = try mapper.createEncryptedUploadV2ResumeRequest(
            transportSessionID: request.transportSessionID,
            uploadSessionID: request.uploadSessionID,
            recordingUUID: request.recordingUUID,
            recordingGeneration: request.recordingGeneration,
            checkpointRevision: request.checkpointRevision,
            nextCiphertextOffset: request.nextCiphertextOffset,
            prefixSHA256: request.prefixSHA256,
            windowPackets: request.windowPackets,
            dataPayloadBytes: request.dataPayloadBytes
        )
        let terminal: MatchedTransferControlReply<EncryptedUploadV2ResumeDecision> = try await exchange(
            peripheralID: peripheralID,
            frame: frame,
            transportSessionID: request.transportSessionID,
            failedMessageType: Self.resumeRequestMessageType,
            replyTimeoutNanoseconds: replyTimeoutNanoseconds,
            cleanupTimeoutNanoseconds: cleanupTimeoutNanoseconds,
            retainSubscription: { decision in
                if case .accepted = decision { return true }
                return false
            }
        ) { value in
            switch value {
            case let .resumeAccepted(accepted):
                guard accepted.uploadSessionID == request.uploadSessionID,
                      Self.sameUUID(accepted.recordingUUID, request.recordingUUID),
                      accepted.recordingGeneration == request.recordingGeneration,
                      accepted.checkpointRevision == request.checkpointRevision,
                      accepted.nextCiphertextOffset == request.nextCiphertextOffset,
                      accepted.prefixSHA256 == request.prefixSHA256,
                      accepted.windowPackets == request.windowPackets,
                      accepted.dataPayloadBytes == request.dataPayloadBytes
                else {
                    throw Self.error(
                        code: .identityMismatch,
                        detail: "RESUME_ACCEPT does not match the requested recording or checkpoint"
                    )
                }
                return .accepted(accepted)
            case let .resumeRejected(rejected):
                guard rejected.reason != 0 else {
                    throw Self.error(
                        code: .unexpectedEvent,
                        detail: "RESUME_REJECT cannot carry a success result"
                    )
                }
                return .rejected(rejected)
            case .startAccepted, .error:
                return nil
            }
        }
        switch terminal {
        case let .value(decision):
            return decision
        case let .deviceError(error):
            throw Self.deviceRejection(error)
        }
    }

    func resetAfterConfirmedDisconnect() {
        cleanupUncertain = false
        activeTransfer = nil
    }

    func claimNotificationStream(
        transportSessionID: UInt64
    ) throws -> AsyncThrowingStream<Data, Error> {
        guard var transfer = activeTransfer,
              transfer.transportSessionID == transportSessionID
        else {
            throw Self.error(
                code: .identityMismatch,
                detail: "no active encrypted transfer matches the requested transport session"
            )
        }
        guard !transfer.notificationStreamClaimed else {
            throw Self.error(
                code: .operationInProgress,
                detail: "the active encrypted transfer notification stream is already claimed"
            )
        }
        transfer.notificationStreamClaimed = true
        activeTransfer = transfer
        return transfer.notifications
    }

    func writeActiveTransferFrame(
        transportSessionID: UInt64,
        frame: Data
    ) async throws {
        guard let transfer = activeTransfer,
              transfer.transportSessionID == transportSessionID,
              transfer.notificationStreamClaimed
        else {
            throw Self.error(
                code: .identityMismatch,
                detail: "no claimed encrypted transfer matches the requested transport session"
            )
        }
        guard frame.count >= 68,
              frame.first == 0x21,
              Self.readUInt64(frame, at: 4) == transportSessionID
        else {
            throw Self.error(
                code: .invalidInput,
                detail: "active encrypted transfer frame is malformed or belongs to another session"
            )
        }
        try await write(transfer.peripheralID, frame)
    }

    func abortActiveTransfer(
        transportSessionID: UInt64,
        reason: UInt16,
        cleanupTimeoutNanoseconds: UInt64 = defaultCleanupTimeoutNanoseconds
    ) async throws {
        guard !exchangeActive else {
            throw Self.error(
                code: .operationInProgress,
                detail: "an encrypted transfer-control exchange is still active"
            )
        }
        guard let transfer = activeTransfer,
              transfer.transportSessionID == transportSessionID
        else {
            throw Self.error(
                code: .identityMismatch,
                detail: "no active encrypted transfer matches the requested transport session"
            )
        }
        exchangeActive = true
        defer { exchangeActive = false }

        let abort = try mapper.createEncryptedUploadV2Abort(
            transportSessionID: transportSessionID,
            reason: reason
        )
        let cleaned = await cleanup(
            peripheralID: transfer.peripheralID,
            abort: abort,
            timeoutNanoseconds: cleanupTimeoutNanoseconds
        )
        activeTransfer = nil
        guard cleaned else {
            throw Self.error(
                code: .uploadOwnershipUnknown,
                detail: "active encrypted transfer cleanup is uncertain"
            )
        }
    }

    private func exchange<Value: Sendable>(
        peripheralID: String,
        frame: Data,
        transportSessionID: UInt64,
        failedMessageType: UInt8,
        replyTimeoutNanoseconds: UInt64,
        cleanupTimeoutNanoseconds: UInt64,
        retainSubscription: @escaping @Sendable (Value) -> Bool,
        match: @escaping @Sendable (EncryptedUploadV2TransferControlValue) throws -> Value?
    ) async throws -> MatchedTransferControlReply<Value> {
        guard !exchangeActive, activeTransfer == nil else {
            throw Self.error(
                code: .operationInProgress,
                detail: "another encrypted transfer-control owner is active"
            )
        }
        guard !cleanupUncertain else {
            throw Self.error(
                code: .uploadOwnershipUnknown,
                detail: "transfer-control cleanup is uncertain; reconnect before retrying"
            )
        }
        exchangeActive = true
        defer { exchangeActive = false }

        let abort = try mapper.createEncryptedUploadV2Abort(
            transportSessionID: transportSessionID,
            reason: Self.cleanupAbortReason
        )
        let notifications = try await subscribe(peripheralID)
        var sent = false
        var terminalReleasesDevice = false
        var cleanupAttempted = false

        do {
            let reply = try await withThrowingTaskGroup(
                of: MatchedTransferControlReply<Value>.self
            ) { group in
                group.addTask {
                    for try await data in notifications {
                        let value = try self.mapper.decodeEncryptedUploadV2TransferControl(data)
                        guard value.transportSessionID == transportSessionID else {
                            throw Self.error(
                                code: .identityMismatch,
                                detail: "encrypted transfer reply belongs to another transport session"
                            )
                        }
                        if case let .error(error) = value {
                            guard error.failedMessageType == failedMessageType,
                                  error.result != 0
                            else {
                                throw Self.error(
                                    code: .unexpectedEvent,
                                    detail: "encrypted transfer ERROR does not match the active request"
                                )
                            }
                            return .deviceError(error)
                        }
                        guard let matched = try match(value) else {
                            throw Self.error(
                                code: .unexpectedEvent,
                                detail: "encrypted transfer reply type does not match the active request"
                            )
                        }
                        return .value(matched)
                    }
                    try Task.checkCancellation()
                    throw Self.error(
                        code: .unexpectedEvent,
                        detail: "transfer-control notification stream ended without a matching reply"
                    )
                }
                do {
                    try Task.checkCancellation()
                    sent = true
                    try await write(peripheralID, frame)
                    group.addTask {
                        try await Task.sleep(nanoseconds: replyTimeoutNanoseconds)
                        throw Self.error(
                            code: .timeout,
                            retryable: true,
                            detail: "timed out waiting for the matching transfer-control reply"
                        )
                    }
                    guard let reply = try await group.next() else {
                        throw Self.error(
                            code: .unexpectedEvent,
                            detail: "transfer-control reply race ended unexpectedly"
                        )
                    }
                    group.cancelAll()
                    return reply
                } catch {
                    group.cancelAll()
                    throw error
                }
            }
            let retain = switch reply {
            case let .value(value): retainSubscription(value)
            case .deviceError: false
            }
            if retain {
                try Task.checkCancellation()
                activeTransfer = ActiveEncryptedUploadV2Transfer(
                    peripheralID: peripheralID,
                    transportSessionID: transportSessionID,
                    notifications: notifications
                )
                return reply
            }
            terminalReleasesDevice = true
            try Task.checkCancellation()
            cleanupAttempted = true
            guard await cleanup(
                peripheralID: peripheralID,
                abort: nil,
                timeoutNanoseconds: cleanupTimeoutNanoseconds
            ) else {
                throw Self.error(
                    code: .uploadOwnershipUnknown,
                    detail: "transfer-control subscription cleanup is uncertain"
                )
            }
            return reply
        } catch {
            if !cleanupAttempted {
                _ = await cleanup(
                    peripheralID: peripheralID,
                    abort: sent && !terminalReleasesDevice ? abort : nil,
                    timeoutNanoseconds: cleanupTimeoutNanoseconds
                )
            }
            throw error
        }
    }

    private func cleanup(
        peripheralID: String,
        abort: Data?,
        timeoutNanoseconds: UInt64
    ) async -> Bool {
        let write = self.write
        let unsubscribe = self.unsubscribe
        let completed = await Self.boundedCleanup(timeoutNanoseconds: timeoutNanoseconds) {
            var firstError: Error?
            if let abort {
                do {
                    try await write(peripheralID, abort)
                } catch {
                    firstError = error
                }
            }
            do {
                try await unsubscribe(peripheralID)
            } catch {
                if firstError == nil { firstError = error }
            }
            if let firstError { throw firstError }
        }
        if !completed { cleanupUncertain = true }
        return completed
    }

    private static func boundedCleanup(
        timeoutNanoseconds: UInt64,
        operation: @escaping @Sendable () async throws -> Void
    ) async -> Bool {
        await withCheckedContinuation { continuation in
            let race = TransferControlCleanupRace(continuation)
            Task.detached {
                do {
                    try await operation()
                    race.resolve(true)
                } catch {
                    race.resolve(false)
                }
            }
            Task.detached {
                try? await Task.sleep(nanoseconds: timeoutNanoseconds)
                race.resolve(false)
            }
        }
    }

    private static func sameUUID(_ lhs: String, _ rhs: String) -> Bool {
        guard let lhs = UUID(uuidString: lhs), let rhs = UUID(uuidString: rhs) else { return false }
        return lhs == rhs
    }

    private static func readUInt64(_ data: Data, at offset: Int) -> UInt64 {
        data[offset..<(offset + 8)].enumerated().reduce(0) { value, pair in
            value | (UInt64(pair.element) << UInt64(pair.offset * 8))
        }
    }

    private static func deviceRejection(
        _ error: EncryptedUploadV2TransferErrorValue
    ) -> EncryptedUploadV2TransferControlRejection {
        EncryptedUploadV2TransferControlRejection(
            sdkError: Self.error(
                code: .protocolRejected,
                protocolStatus: error.result,
                detail: "device rejected the encrypted transfer-control request"
            ),
            deviceError: error
        )
    }

    private static func error(
        code: BotaSDKErrorCode,
        retryable: Bool = false,
        protocolStatus: UInt16? = nil,
        detail: String
    ) -> BotaSDKError {
        BotaSDKError(
            code: code,
            operation: .transferRecording,
            retryable: retryable,
            protocolStatus: protocolStatus,
            detail: detail
        )
    }
}

private struct ActiveEncryptedUploadV2Transfer: Sendable {
    let peripheralID: String
    let transportSessionID: UInt64
    let notifications: AsyncThrowingStream<Data, Error>
    var notificationStreamClaimed = false
}

private enum MatchedTransferControlReply<Value: Sendable>: Sendable {
    case value(Value)
    case deviceError(EncryptedUploadV2TransferErrorValue)
}

private extension EncryptedUploadV2TransferControlValue {
    var transportSessionID: UInt64 {
        switch self {
        case let .startAccepted(value): value.transportSessionID
        case let .resumeAccepted(value): value.transportSessionID
        case let .resumeRejected(value): value.transportSessionID
        case let .error(value): value.transportSessionID
        }
    }
}

private final class TransferControlCleanupRace: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Never>?

    init(_ continuation: CheckedContinuation<Bool, Never>) {
        self.continuation = continuation
    }

    func resolve(_ value: Bool) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(returning: value)
    }
}
