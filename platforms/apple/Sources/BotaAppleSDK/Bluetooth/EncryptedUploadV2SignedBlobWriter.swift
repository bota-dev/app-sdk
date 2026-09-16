import CryptoKit
import Foundation

actor EncryptedUploadV2SignedBlobWriter {
    typealias MaximumWriteLength = @Sendable (String) async throws -> Int
    typealias Subscribe = @Sendable (String) async throws -> AsyncThrowingStream<Data, Error>
    typealias Write = @Sendable (String, Data) async throws -> Void
    typealias Unsubscribe = @Sendable (String) async throws -> Void

    private static let beginFrameBytes = 42
    private static let dataFrameOverheadBytes = 12
    private static let protocolMaximumFrameBytes = 512
    private static let defaultResultTimeoutNanoseconds: UInt64 = 10_000_000_000
    private static let defaultCleanupTimeoutNanoseconds: UInt64 = 1_000_000_000

    private let mapper: CoreModelMapper
    private let maximumWriteLength: MaximumWriteLength
    private let subscribe: Subscribe
    private let write: Write
    private let unsubscribe: Unsubscribe
    private var active = false
    private var cleanupUncertain = false

    init(
        mapper: CoreModelMapper,
        maximumWriteLength: @escaping MaximumWriteLength,
        subscribe: @escaping Subscribe,
        write: @escaping Write,
        unsubscribe: @escaping Unsubscribe
    ) {
        self.mapper = mapper
        self.maximumWriteLength = maximumWriteLength
        self.subscribe = subscribe
        self.write = write
        self.unsubscribe = unsubscribe
    }

    init(bluetooth: CoreBluetoothHost, mapper: CoreModelMapper) {
        self.init(
            mapper: mapper,
            maximumWriteLength: { try await bluetooth.maximumWriteValueLength(peripheralID: $0) },
            subscribe: { peripheralID in
                try await bluetooth.subscribe(
                    peripheralID: peripheralID,
                    serviceUUID: BotaBluetoothUUIDs.storageService,
                    characteristicUUID: BotaBluetoothUUIDs.transferSignedBlobV2
                )
            },
            write: { peripheralID, data in
                try await bluetooth.write(
                    peripheralID: peripheralID,
                    serviceUUID: BotaBluetoothUUIDs.storageService,
                    characteristicUUID: BotaBluetoothUUIDs.transferSignedBlobV2,
                    data: data
                )
            },
            unsubscribe: { peripheralID in
                try await bluetooth.unsubscribe(
                    peripheralID: peripheralID,
                    serviceUUID: BotaBluetoothUUIDs.storageService,
                    characteristicUUID: BotaBluetoothUUIDs.transferSignedBlobV2
                )
            }
        )
    }

    func send(
        peripheralID: String,
        kind: UInt8,
        writeID: UInt32,
        document: Data,
        maximumDocumentBytes: UInt16,
        resultTimeoutNanoseconds: UInt64 = defaultResultTimeoutNanoseconds,
        cleanupTimeoutNanoseconds: UInt64 = defaultCleanupTimeoutNanoseconds
    ) async throws {
        guard !active else {
            throw Self.error(
                code: .operationInProgress,
                detail: "another signed-document owner is active"
            )
        }
        guard !cleanupUncertain else {
            throw Self.error(
                code: .uploadOwnershipUnknown,
                detail: "signed-document cleanup is uncertain; reconnect before retrying"
            )
        }
        active = true
        defer { active = false }

        guard document.count <= Int(maximumDocumentBytes),
              let totalLength = UInt16(exactly: document.count)
        else {
            throw Self.error(
                code: .payloadTooLarge,
                detail: "signed document exceeds the advertised device capacity"
            )
        }

        let begin = try mapper.createEncryptedUploadV2SignedBlobBegin(
            kind: kind,
            writeID: writeID,
            totalLength: totalLength,
            sha256: Data(SHA256.hash(data: document))
        )
        let commit = try mapper.createEncryptedUploadV2SignedBlobCommit(kind: kind, writeID: writeID)
        let abort = try mapper.createEncryptedUploadV2SignedBlobAbort(kind: kind, writeID: writeID)
        let maximumFrameBytes = try await maximumWriteLength(peripheralID)
        let boundedFrameBytes = min(maximumFrameBytes, Self.protocolMaximumFrameBytes)
        guard boundedFrameBytes >= Self.beginFrameBytes else {
            throw Self.error(
                code: .invalidInput,
                detail: "platform write limit cannot carry a signed-blob BEGIN frame"
            )
        }
        let chunkBytes = boundedFrameBytes - Self.dataFrameOverheadBytes
        guard chunkBytes > 0 else {
            throw Self.error(code: .invalidInput, detail: "platform write limit cannot carry signed-blob DATA")
        }

        let notifications = try await subscribe(peripheralID)
        var began = false
        var receivedTerminalResult = false
        var cleanupAttempted = false

        do {
            let result = try await withThrowingTaskGroup(
                of: EncryptedUploadV2SignedBlobResultValue.self
            ) { group in
                group.addTask {
                    try await self.matchingResult(notifications, kind: kind, writeID: writeID)
                }
                do {
                    try Task.checkCancellation()
                    began = true
                    try await write(peripheralID, begin)
                    var offset = 0
                    while offset < document.count {
                        try Task.checkCancellation()
                        let end = min(offset + chunkBytes, document.count)
                        let frame = try mapper.createEncryptedUploadV2SignedBlobData(
                            kind: kind,
                            writeID: writeID,
                            offset: UInt16(offset),
                            data: document.subdata(in: offset..<end)
                        )
                        try await write(peripheralID, frame)
                        offset = end
                    }
                    try Task.checkCancellation()
                    try await write(peripheralID, commit)
                    group.addTask {
                        try await Task.sleep(nanoseconds: resultTimeoutNanoseconds)
                        throw Self.error(
                            code: .timeout,
                            retryable: true,
                            detail: "timed out waiting for the matching signed-blob result"
                        )
                    }
                    guard let result = try await group.next() else {
                        throw Self.error(
                            code: .unexpectedEvent,
                            detail: "signed-blob result race ended unexpectedly"
                        )
                    }
                    group.cancelAll()
                    return result
                } catch {
                    group.cancelAll()
                    throw error
                }
            }
            receivedTerminalResult = true
            try Task.checkCancellation()
            cleanupAttempted = true
            let cleaned = await cleanup(
                peripheralID: peripheralID,
                abort: nil,
                timeoutNanoseconds: cleanupTimeoutNanoseconds
            )
            guard result.result == 0 else {
                throw Self.error(
                    code: .protocolRejected,
                    protocolStatus: result.result,
                    detail: "device rejected the signed document"
                )
            }
            guard cleaned else {
                throw Self.error(
                    code: .uploadOwnershipUnknown,
                    detail: "signed-document subscription cleanup is uncertain"
                )
            }
        } catch {
            if !cleanupAttempted {
                _ = await cleanup(
                    peripheralID: peripheralID,
                    abort: began && !receivedTerminalResult ? abort : nil,
                    timeoutNanoseconds: cleanupTimeoutNanoseconds
                )
            }
            throw error
        }
    }

    func resetAfterConfirmedDisconnect() {
        cleanupUncertain = false
    }

    private func matchingResult(
        _ notifications: AsyncThrowingStream<Data, Error>,
        kind: UInt8,
        writeID: UInt32
    ) async throws -> EncryptedUploadV2SignedBlobResultValue {
        for try await data in notifications {
            let result = try mapper.decodeEncryptedUploadV2SignedBlobResult(data)
            if result.kind == kind, result.writeID == writeID {
                return result
            }
        }
        try Task.checkCancellation()
        throw Self.error(
            code: .unexpectedEvent,
            detail: "signed-blob notification stream ended without the matching result"
        )
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
                if firstError == nil {
                    firstError = error
                }
            }
            if let firstError {
                throw firstError
            }
        }
        if !completed {
            cleanupUncertain = true
        }
        return completed
    }

    private static func boundedCleanup(
        timeoutNanoseconds: UInt64,
        operation: @escaping @Sendable () async throws -> Void
    ) async -> Bool {
        await withCheckedContinuation { continuation in
            let race = SignedBlobCleanupRace(continuation)
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

private final class SignedBlobCleanupRace: @unchecked Sendable {
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
