import Foundation

struct EncryptedUploadV2ContextSnapshot: Sendable {
    let attemptID: UInt32
    let state: UInt8
    let result: UInt16
    let payload: Data
}

actor EncryptedUploadV2ContextHost {
    private let begin: @Sendable (UInt32) async throws -> Void
    private let read: @Sendable () async throws -> EncryptedUploadV2ContextSnapshot
    private let sendDocument: @Sendable (UInt8, Data) async throws -> Void
    private let validateDocument: @Sendable (UInt8, Data) throws -> Void
    private var activeTask: Task<Void, Never>?

    init(
        begin: @escaping @Sendable (UInt32) async throws -> Void,
        read: @escaping @Sendable () async throws -> EncryptedUploadV2ContextSnapshot,
        sendDocument: @escaping @Sendable (UInt8, Data) async throws -> Void,
        validateDocument: @escaping @Sendable (UInt8, Data) throws -> Void
    ) {
        self.begin = begin
        self.read = read
        self.sendDocument = sendDocument
        self.validateDocument = validateDocument
    }

    func refresh(
        timeoutNanoseconds: UInt64 = 30_000_000_000,
        provider: @escaping EncryptedUploadV2ContextProvider
    ) async throws {
        try Task.checkCancellation()
        guard activeTask == nil else {
            throw Self.error(.operationInProgress, "another upload context attempt is active")
        }
        let attemptID = UInt32.random(in: 1...UInt32.max)
        let pair = AsyncThrowingStream<Void, Error>.makeStream()
        let task = Task {
            defer { activeTask = nil }
            do {
                try Task.checkCancellation()
                try await begin(attemptID)
                let nonce = try await waitFor(state: 1, attemptID: attemptID)
                let exchange = try await provider(nonce)
                try Task.checkCancellation()
                try validateDocument(3, exchange.challenge)
                try await sendDocument(3, exchange.challenge)
                let proof = try await waitFor(state: 2, attemptID: attemptID)
                let result = try await exchange.exchangeProof(proof)
                try Task.checkCancellation()
                try validateDocument(4, result)
                try await sendDocument(4, result)
                _ = try await waitFor(state: 3, attemptID: attemptID)
                pair.continuation.yield(())
                pair.continuation.finish()
            } catch { pair.continuation.finish(throwing: error) }
        }
        activeTask = task
        let timer = Task {
            do {
                try await Task.sleep(nanoseconds: timeoutNanoseconds)
                task.cancel()
                pair.continuation.finish(throwing: Self.error(.timeout, "upload context attempt timed out"))
            } catch {}
        }
        pair.continuation.onTermination = { @Sendable _ in task.cancel(); timer.cancel() }
        defer { task.cancel(); timer.cancel() }
        var iterator = pair.stream.makeAsyncIterator()
        guard try await iterator.next() != nil else { throw facadeCancelled(operation: .transferRecording) }
        try Task.checkCancellation()
    }

    func cancel() async {
        let task = activeTask
        task?.cancel()
        await task?.value
    }

    private func waitFor(state: UInt8, attemptID: UInt32) async throws -> Data {
        while true {
            try Task.checkCancellation()
            let snapshot = try await read()
            try Task.checkCancellation()
            guard snapshot.attemptID == attemptID else {
                throw Self.error(.unexpectedEvent, "upload context attempt does not match")
            }
            if snapshot.state == 4 {
                throw BotaSDKError(code: .protocolRejected, operation: .transferRecording,
                                   retryable: false, protocolStatus: snapshot.result,
                                   detail: "device rejected upload context")
            }
            guard snapshot.state <= state else {
                throw Self.error(.unexpectedEvent, "upload context advanced unexpectedly")
            }
            if snapshot.state == state { return snapshot.payload }
            try await Task.sleep(nanoseconds: 150_000_000)
        }
    }

    private static func error(_ code: BotaSDKErrorCode, _ detail: String) -> BotaSDKError {
        BotaSDKError(code: code, operation: .transferRecording, retryable: code == .timeout, detail: detail)
    }
}
