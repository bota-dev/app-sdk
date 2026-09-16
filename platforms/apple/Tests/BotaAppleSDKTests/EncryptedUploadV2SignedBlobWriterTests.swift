import CryptoKit
import Foundation
import XCTest
@testable import BotaAppleSDK

final class EncryptedUploadV2SignedBlobWriterTests: XCTestCase {
    func testSubscribesThenWritesCoreEncodedFramesWithinPlatformLimit() async throws {
        let document = Data(repeating: 0xa5, count: 408)
        let probe = SignedBlobTransportProbe(
            maximumFrameBytes: 64,
            resultNotifications: [Self.result(kind: 1, writeID: 0x0102_0304, status: 0)]
        )
        let writer = try Self.writer(probe: probe)

        try await writer.send(
            peripheralID: "peripheral-1",
            kind: 1,
            writeID: 0x0102_0304,
            document: document,
            maximumDocumentBytes: 1_024
        )

        let snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.calls.first, .maximumWriteLength)
        XCTAssertEqual(snapshot.calls.dropFirst().first, .subscribe)
        XCTAssertEqual(snapshot.calls.last, .unsubscribe)
        XCTAssertEqual(snapshot.frames.count, 10)
        XCTAssertEqual(snapshot.frames.first?.count, 42)
        XCTAssertEqual(snapshot.frames.first?.first, 0x60)
        XCTAssertEqual(snapshot.frames.first.map { Data($0[10..<42]) }, Data(SHA256.hash(data: document)))
        XCTAssertEqual(snapshot.frames.last, Data([0x62, 0x02, 0x01, 0x00, 0x04, 0x03, 0x02, 0x01]))
        XCTAssertTrue(snapshot.frames.allSatisfy { $0.count <= 64 })

        let dataFrames = snapshot.frames.dropFirst().dropLast()
        XCTAssertTrue(dataFrames.allSatisfy { $0.first == 0x61 })
        XCTAssertEqual(Data(dataFrames.flatMap { $0.dropFirst(12) }), document)
        XCTAssertEqual(dataFrames.map { Self.u16($0, at: 8) }, [0, 52, 104, 156, 208, 260, 312, 364])
    }

    func testIgnoresAnotherOwnerResultAndRequiresExactMatchingSuccess() async throws {
        let probe = SignedBlobTransportProbe(
            maximumFrameBytes: 80,
            resultNotifications: [
                Self.result(kind: 1, writeID: 9, status: 0),
                Self.result(kind: 2, writeID: 7, status: 0),
            ]
        )
        let writer = try Self.writer(probe: probe)

        try await writer.send(
            peripheralID: "peripheral-1",
            kind: 2,
            writeID: 7,
            document: Data(repeating: 0x5a, count: 336),
            maximumDocumentBytes: 1_024
        )

        let snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.frames.last?.first, 0x62)
        XCTAssertEqual(snapshot.calls.last, .unsubscribe)
        XCTAssertEqual(snapshot.calls.filter { $0 == .unsubscribe }.count, 1)
    }

    func testMatchingDeviceRejectionFailsWithoutSendingAnotherTerminalFrame() async throws {
        let probe = SignedBlobTransportProbe(
            maximumFrameBytes: 80,
            resultNotifications: [Self.result(kind: 1, writeID: 7, status: 4)]
        )
        let writer = try Self.writer(probe: probe)

        do {
            try await writer.send(
                peripheralID: "peripheral-1",
                kind: 1,
                writeID: 7,
                document: Data(repeating: 0x5a, count: 408),
                maximumDocumentBytes: 1_024
            )
            XCTFail("Expected the device result to reject the signed document")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .protocolRejected)
            XCTAssertEqual(error.operation, .transferRecording)
            XCTAssertEqual(error.protocolStatus, 4)
        }

        let snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.frames.last?.first, 0x62)
        XCTAssertEqual(snapshot.calls.last, .unsubscribe)
    }

    func testWriteFailureBestEffortAbortsOwnerAndUnsubscribes() async throws {
        let probe = SignedBlobTransportProbe(
            maximumFrameBytes: 64,
            resultNotifications: [],
            failWriteIndex: 1
        )
        let writer = try Self.writer(probe: probe)

        do {
            try await writer.send(
                peripheralID: "peripheral-1",
                kind: 1,
                writeID: 7,
                document: Data(repeating: 0x5a, count: 408),
                maximumDocumentBytes: 1_024
            )
            XCTFail("Expected the DATA write to fail")
        } catch SignedBlobProbeError.writeFailed {
            // Expected.
        }

        let snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.frames.last, Data([0x63, 0x02, 0x01, 0x00, 0x07, 0x00, 0x00, 0x00]))
        XCTAssertEqual(snapshot.calls.last, .unsubscribe)
    }

    func testRejectsAPlatformWriteLimitThatCannotCarryBegin() async throws {
        let probe = SignedBlobTransportProbe(maximumFrameBytes: 41, resultNotifications: [])
        let writer = try Self.writer(probe: probe)

        do {
            try await writer.send(
                peripheralID: "peripheral-1",
                kind: 2,
                writeID: 7,
                document: Data(repeating: 0x5a, count: 336),
                maximumDocumentBytes: 1_024
            )
            XCTFail("Expected the platform write limit to fail")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .invalidInput)
        }

        let snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.calls, [.maximumWriteLength])
        XCTAssertTrue(snapshot.frames.isEmpty)
    }

    func testResultTimeoutAbortsOwnerAndUnsubscribes() async throws {
        let probe = SignedBlobTransportProbe(maximumFrameBytes: 80, resultNotifications: [])
        let writer = try Self.writer(probe: probe)

        do {
            try await writer.send(
                peripheralID: "peripheral-1",
                kind: 2,
                writeID: 7,
                document: Data(repeating: 0x5a, count: 336),
                maximumDocumentBytes: 1_024,
                resultTimeoutNanoseconds: 1_000_000
            )
            XCTFail("Expected the matching-result wait to time out")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .timeout)
            XCTAssertTrue(error.retryable)
        }

        let snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.frames.last?.first, 0x63)
        XCTAssertEqual(snapshot.calls.last, .unsubscribe)
    }

    func testRejectsASecondOwnerWhileTheFirstSendIsSuspended() async throws {
        let probe = SignedBlobTransportProbe(
            maximumFrameBytes: 80,
            resultNotifications: [Self.result(kind: 2, writeID: 7, status: 0)],
            suspendMaximumWriteLength: true
        )
        let writer = try Self.writer(probe: probe)
        let first = Task {
            try await writer.send(
                peripheralID: "peripheral-1",
                kind: 2,
                writeID: 7,
                document: Data(repeating: 0x5a, count: 336),
                maximumDocumentBytes: 1_024
            )
        }
        try await Self.waitUntil { await probe.maximumWriteLengthWaiterCount == 1 }

        do {
            try await writer.send(
                peripheralID: "peripheral-1",
                kind: 2,
                writeID: 8,
                document: Data(repeating: 0x5a, count: 336),
                maximumDocumentBytes: 1_024
            )
            XCTFail("Expected the concurrent owner to be rejected")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .operationInProgress)
        }

        await probe.resumeMaximumWriteLength()
        try await first.value
    }

    func testCallerCancellationAbortsAndReleasesTheOwnerWithoutWaitingForResultTimeout() async throws {
        let probe = SignedBlobTransportProbe(maximumFrameBytes: 80, resultNotifications: [])
        let writer = try Self.writer(probe: probe)
        let send = Task {
            try await writer.send(
                peripheralID: "peripheral-1",
                kind: 2,
                writeID: 7,
                document: Data(repeating: 0x5a, count: 336),
                maximumDocumentBytes: 1_024,
                resultTimeoutNanoseconds: 1_000_000_000,
                cleanupTimeoutNanoseconds: 10_000_000
            )
        }
        try await Self.waitUntil { await probe.hasFrame(code: 0x62) }

        send.cancel()
        do {
            try await send.value
            XCTFail("Expected cancellation")
        } catch is CancellationError {
            // Expected.
        }

        let snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.frames.last?.first, 0x63)
        XCTAssertEqual(snapshot.calls.last, .unsubscribe)
    }

    func testStalledAbortCleanupIsBoundedAndPoisonsOwnershipUntilDisconnect() async throws {
        let probe = SignedBlobTransportProbe(
            maximumFrameBytes: 80,
            resultNotifications: [],
            suspendWriteCode: 0x63
        )
        let writer = try Self.writer(probe: probe)

        do {
            try await writer.send(
                peripheralID: "peripheral-1",
                kind: 2,
                writeID: 7,
                document: Data(repeating: 0x5a, count: 336),
                maximumDocumentBytes: 1_024,
                resultTimeoutNanoseconds: 1_000_000,
                cleanupTimeoutNanoseconds: 1_000_000
            )
            XCTFail("Expected the result wait to time out")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .timeout)
        }
        do {
            try await writer.send(
                peripheralID: "peripheral-1",
                kind: 2,
                writeID: 8,
                document: Data(repeating: 0x5a, count: 336),
                maximumDocumentBytes: 1_024
            )
            XCTFail("Expected uncertain cleanup ownership to fail closed")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .uploadOwnershipUnknown)
        }

        await probe.resumeSuspendedWrite()
    }

    func testStalledUnsubscribeAfterSuccessIsBoundedAndFailsClosed() async throws {
        let probe = SignedBlobTransportProbe(
            maximumFrameBytes: 80,
            resultNotifications: [Self.result(kind: 2, writeID: 7, status: 0)],
            suspendUnsubscribe: true
        )
        let writer = try Self.writer(probe: probe)

        do {
            try await writer.send(
                peripheralID: "peripheral-1",
                kind: 2,
                writeID: 7,
                document: Data(repeating: 0x5a, count: 336),
                maximumDocumentBytes: 1_024,
                cleanupTimeoutNanoseconds: 1_000_000
            )
            XCTFail("Expected stalled subscription cleanup to fail closed")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .uploadOwnershipUnknown)
        }

        await probe.resumeSuspendedUnsubscribe()
    }

    func testPlatformLimitAboveProtocolMaximumStillProducesBoundedFrames() async throws {
        let probe = SignedBlobTransportProbe(
            maximumFrameBytes: 1_024,
            resultNotifications: [Self.result(kind: 1, writeID: 7, status: 0)]
        )
        let writer = try Self.writer(probe: probe)

        try await writer.send(
            peripheralID: "peripheral-1",
            kind: 1,
            writeID: 7,
            document: Data(repeating: 0x5a, count: 408),
            maximumDocumentBytes: 1_024
        )

        let snapshot = await probe.snapshot()
        XCTAssertLessThanOrEqual(snapshot.frames.map(\.count).max() ?? 0, 512)
    }

    func testResultTimeoutStartsAfterSlowWritesComplete() async throws {
        let probe = SignedBlobTransportProbe(
            maximumFrameBytes: 80,
            resultNotifications: [Self.result(kind: 2, writeID: 7, status: 0)],
            writeDelayNanoseconds: 2_000_000
        )
        let writer = try Self.writer(probe: probe)

        try await writer.send(
            peripheralID: "peripheral-1",
            kind: 2,
            writeID: 7,
            document: Data(repeating: 0x5a, count: 336),
            maximumDocumentBytes: 1_024,
            resultTimeoutNanoseconds: 1_000_000
        )
    }

    private static func writer(probe: SignedBlobTransportProbe) throws -> EncryptedUploadV2SignedBlobWriter {
        EncryptedUploadV2SignedBlobWriter(
            mapper: try CoreModelMapper(),
            maximumWriteLength: { peripheralID in
                try await probe.maximumWriteLength(peripheralID: peripheralID)
            },
            subscribe: { peripheralID in
                try await probe.subscribe(peripheralID: peripheralID)
            },
            write: { peripheralID, data in
                try await probe.write(peripheralID: peripheralID, data: data)
            },
            unsubscribe: { peripheralID in
                try await probe.unsubscribe(peripheralID: peripheralID)
            }
        )
    }

    private static func result(kind: UInt8, writeID: UInt32, status: UInt16) -> Data {
        Data([
            0x64, 0x02, kind, 0x00,
            UInt8(truncatingIfNeeded: writeID),
            UInt8(truncatingIfNeeded: writeID >> 8),
            UInt8(truncatingIfNeeded: writeID >> 16),
            UInt8(truncatingIfNeeded: writeID >> 24),
            UInt8(truncatingIfNeeded: status),
            UInt8(truncatingIfNeeded: status >> 8),
        ])
    }

    private static func u16(_ data: Data, at offset: Int) -> UInt16 {
        UInt16(data[offset]) | (UInt16(data[offset + 1]) << 8)
    }

    private static func waitUntil(
        timeoutNanoseconds: UInt64 = 500_000_000,
        condition: @escaping @Sendable () async -> Bool
    ) async throws {
        let deadline = ContinuousClock.now + .nanoseconds(Int64(timeoutNanoseconds))
        while !(await condition()) {
            if ContinuousClock.now >= deadline { throw SignedBlobProbeError.waitTimedOut }
            await Task.yield()
        }
    }
}

private enum SignedBlobTransportCall: Equatable {
    case maximumWriteLength
    case subscribe
    case write
    case unsubscribe
}

private enum SignedBlobProbeError: Error {
    case writeFailed
    case waitTimedOut
}

private actor SignedBlobTransportProbe {
    private let maximumFrameBytes: Int
    private let resultNotifications: [Data]
    private let failWriteIndex: Int?
    private let suspendMaximumWriteLength: Bool
    private var suspendWriteCode: UInt8?
    private var suspendUnsubscribe: Bool
    private let writeDelayNanoseconds: UInt64
    private var didFailWrite = false
    private var maximumWriteLengthContinuation: CheckedContinuation<Int, Never>?
    private var suspendedWriteContinuation: CheckedContinuation<Void, Error>?
    private var suspendedUnsubscribeContinuation: CheckedContinuation<Void, Error>?
    private var continuation: AsyncThrowingStream<Data, Error>.Continuation?
    private var calls: [SignedBlobTransportCall] = []
    private var frames: [Data] = []

    init(
        maximumFrameBytes: Int,
        resultNotifications: [Data],
        failWriteIndex: Int? = nil,
        suspendMaximumWriteLength: Bool = false,
        suspendWriteCode: UInt8? = nil,
        suspendUnsubscribe: Bool = false,
        writeDelayNanoseconds: UInt64 = 0
    ) {
        self.maximumFrameBytes = maximumFrameBytes
        self.resultNotifications = resultNotifications
        self.failWriteIndex = failWriteIndex
        self.suspendMaximumWriteLength = suspendMaximumWriteLength
        self.suspendWriteCode = suspendWriteCode
        self.suspendUnsubscribe = suspendUnsubscribe
        self.writeDelayNanoseconds = writeDelayNanoseconds
    }

    func maximumWriteLength(peripheralID: String) async throws -> Int {
        calls.append(.maximumWriteLength)
        if suspendMaximumWriteLength {
            return await withCheckedContinuation { maximumWriteLengthContinuation = $0 }
        }
        return maximumFrameBytes
    }

    var maximumWriteLengthWaiterCount: Int { maximumWriteLengthContinuation == nil ? 0 : 1 }

    func resumeMaximumWriteLength() {
        maximumWriteLengthContinuation?.resume(returning: maximumFrameBytes)
        maximumWriteLengthContinuation = nil
    }

    func subscribe(peripheralID: String) throws -> AsyncThrowingStream<Data, Error> {
        calls.append(.subscribe)
        return AsyncThrowingStream { continuation in self.continuation = continuation }
    }

    func write(peripheralID: String, data: Data) async throws {
        calls.append(.write)
        let index = frames.count
        frames.append(data)
        if failWriteIndex == index, !didFailWrite {
            didFailWrite = true
            throw SignedBlobProbeError.writeFailed
        }
        if data.first == suspendWriteCode {
            try await withCheckedThrowingContinuation { suspendedWriteContinuation = $0 }
        }
        if writeDelayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: writeDelayNanoseconds)
        }
        if data.first == 0x62 {
            resultNotifications.forEach { continuation?.yield($0) }
            if !resultNotifications.isEmpty {
                continuation?.finish()
            }
        }
    }

    func unsubscribe(peripheralID: String) async throws {
        calls.append(.unsubscribe)
        if suspendUnsubscribe {
            try await withCheckedThrowingContinuation { suspendedUnsubscribeContinuation = $0 }
        }
        continuation?.finish()
        continuation = nil
    }

    func hasFrame(code: UInt8) -> Bool { frames.contains { $0.first == code } }

    func resumeSuspendedWrite() {
        suspendWriteCode = nil
        suspendedWriteContinuation?.resume()
        suspendedWriteContinuation = nil
    }

    func resumeSuspendedUnsubscribe() {
        suspendUnsubscribe = false
        suspendedUnsubscribeContinuation?.resume()
        suspendedUnsubscribeContinuation = nil
    }

    func snapshot() -> (calls: [SignedBlobTransportCall], frames: [Data]) {
        (calls, frames)
    }
}
