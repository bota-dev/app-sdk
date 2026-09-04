import Foundation
import XCTest

@testable import BotaAppleSDK

final class EncryptedUploadV2TransferControlTests: XCTestCase {
    func testCoreBluetoothRouteWrites0408AndReceivesAndCleansUp0409() async throws {
        let driver = FakeCentralDriver()
        await driver.setSubscriptionNotifications([Self.startAcknowledgement()])
        let control = EncryptedUploadV2TransferControl(
            bluetooth: CoreBluetoothHost(driver: driver),
            mapper: try CoreModelMapper()
        )

        _ = try await control.start(
            peripheralID: "peripheral-1",
            request: Self.startRequest()
        )
        try await control.abortActiveTransfer(
            transportSessionID: Self.transportSessionID,
            reason: 0x00FF
        )

        let log = await driver.characteristicLog
        XCTAssertEqual(log, [
            "subscribe:\(BotaBluetoothUUIDs.storageService):\(BotaBluetoothUUIDs.recordingTransferV2)",
            "write:\(BotaBluetoothUUIDs.storageService):\(BotaBluetoothUUIDs.transferControlV2):true",
            "write:\(BotaBluetoothUUIDs.storageService):\(BotaBluetoothUUIDs.transferControlV2):true",
            "unsubscribe:\(BotaBluetoothUUIDs.storageService):\(BotaBluetoothUUIDs.recordingTransferV2)",
        ])
    }

    func testForeignTransportSessionFailsClosed() async throws {
        let expected = Self.startAcknowledgement()
        var unrelated = expected
        unrelated.replaceSubrange(4..<12, with: Self.u64(99))
        let probe = TransferControlProbe(notifications: [unrelated, expected])
        let control = try Self.control(probe)

        do {
            _ = try await control.start(
                peripheralID: "peripheral-1",
                request: Self.startRequest()
            )
            XCTFail("Expected foreign-session traffic to terminate the exchange")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .identityMismatch)
        }

        let snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.calls, [.subscribe, .write, .write, .unsubscribe])
        XCTAssertEqual(snapshot.frames.map(\.first), [0x20, 0x24])
    }

    func testStartRetainsLiveNotificationOwnershipUntilExplicitAbort() async throws {
        let probe = TransferControlProbe(notifications: [Self.startAcknowledgement()])
        let control = try Self.control(probe)

        let result = try await control.start(
            peripheralID: "peripheral-1",
            request: Self.startRequest()
        )
        XCTAssertEqual(result.transportSessionID, Self.transportSessionID)
        _ = try await control.claimNotificationStream(
            transportSessionID: Self.transportSessionID
        )

        do {
            _ = try await control.start(
                peripheralID: "peripheral-1",
                request: Self.startRequest()
            )
            XCTFail("Expected the active transfer owner to block another START")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .operationInProgress)
        }

        var snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.calls, [.subscribe, .write])
        XCTAssertEqual(snapshot.frames.map(\.first), [0x20])

        try await control.abortActiveTransfer(
            transportSessionID: Self.transportSessionID,
            reason: 0x00FF
        )
        snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.calls.last, .unsubscribe)
        XCTAssertEqual(snapshot.frames.map(\.first), [0x20, 0x24])
    }

    func testStartIdentityMismatchFailsClosedAndBestEffortAborts() async throws {
        var mismatch = Self.startAcknowledgement()
        mismatch.replaceSubrange(44..<48, with: Self.u32(10))
        let probe = TransferControlProbe(notifications: [mismatch])
        let control = try Self.control(probe)

        do {
            _ = try await control.start(
                peripheralID: "peripheral-1",
                request: Self.startRequest()
            )
            XCTFail("Expected the mismatched START_ACK to fail")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .identityMismatch)
        }

        let snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.frames.map(\.first), [0x20, 0x24])
        XCTAssertEqual(snapshot.calls.last, .unsubscribe)
    }

    func testResumeAcceptRequiresExactContextAndRejectPreservesDeviceCheckpoint() async throws {
        let acceptedProbe = TransferControlProbe(notifications: [Self.resumeAccepted()])
        let acceptedControl = try Self.control(acceptedProbe)
        let acceptedDecision = try await acceptedControl.resume(
            peripheralID: "peripheral-1",
            request: Self.resumeRequest()
        )
        XCTAssertEqual(
            acceptedDecision,
            .accepted(Self.resumeValue())
        )
        try await acceptedControl.abortActiveTransfer(
            transportSessionID: Self.transportSessionID,
            reason: 0x00FF
        )

        let rejectedProbe = TransferControlProbe(notifications: [Self.resumeRejected()])
        let rejectedControl = try Self.control(rejectedProbe)
        let rejectedDecision = try await rejectedControl.resume(
            peripheralID: "peripheral-1",
            request: Self.resumeRequest()
        )
        XCTAssertEqual(
            rejectedDecision,
            .rejected(EncryptedUploadV2ResumeRejectionValue(
                transportSessionID: Self.transportSessionID,
                reason: 15,
                checkpointRevision: 2,
                nextCiphertextOffset: 32,
                prefixSHA256: Data(repeating: 0x11, count: 32)
            ))
        )
        let rejectedSnapshot = await rejectedProbe.snapshot()
        XCTAssertEqual(rejectedSnapshot.calls.last, .unsubscribe)

        var mismatched = Self.resumeAccepted()
        mismatched.replaceSubrange(48..<52, with: Self.u32(4))
        let mismatchProbe = TransferControlProbe(notifications: [mismatched])
        let mismatchControl = try Self.control(mismatchProbe)
        do {
            _ = try await mismatchControl.resume(
                peripheralID: "peripheral-1",
                request: Self.resumeRequest()
            )
            XCTFail("Expected mismatched checkpoint context to fail")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .identityMismatch)
        }
    }

    func testExactDeviceErrorBecomesProtocolRejectionWithoutAnotherTerminalFrame() async throws {
        let probe = TransferControlProbe(notifications: [Self.transferError(
            failedMessageType: 0x20,
            checkpointRevision: 7
        )])
        let control = try Self.control(probe)

        do {
            _ = try await control.start(
                peripheralID: "peripheral-1",
                request: Self.startRequest()
            )
            XCTFail("Expected device rejection")
        } catch let rejection as EncryptedUploadV2TransferControlRejection {
            XCTAssertEqual(rejection.sdkError.code, .protocolRejected)
            XCTAssertEqual(rejection.sdkError.protocolStatus, 15)
            XCTAssertEqual(rejection.deviceError.checkpointRevision, 7)
        }

        let snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.frames.map(\.first), [0x20])
        XCTAssertEqual(snapshot.calls.last, .unsubscribe)
    }

    func testResumeErrorPreservesTheDeviceCheckpointRevision() async throws {
        let probe = TransferControlProbe(notifications: [Self.transferError(
            failedMessageType: 0x22,
            checkpointRevision: 11
        )])
        let control = try Self.control(probe)

        do {
            _ = try await control.resume(
                peripheralID: "peripheral-1",
                request: Self.resumeRequest()
            )
            XCTFail("Expected device rejection")
        } catch let rejection as EncryptedUploadV2TransferControlRejection {
            XCTAssertEqual(rejection.sdkError.code, .protocolRejected)
            XCTAssertEqual(rejection.sdkError.protocolStatus, 15)
            XCTAssertEqual(rejection.deviceError.failedMessageType, 0x22)
            XCTAssertEqual(rejection.deviceError.checkpointRevision, 11)
        }
    }

    func testTimeoutAbortsAndUncertainCleanupPoisonsOwnershipUntilDisconnect() async throws {
        let probe = TransferControlProbe(notifications: [], suspendUnsubscribe: true)
        let control = try Self.control(probe)

        do {
            _ = try await control.start(
                peripheralID: "peripheral-1",
                request: Self.startRequest(),
                replyTimeoutNanoseconds: 1_000_000,
                cleanupTimeoutNanoseconds: 1_000_000
            )
            XCTFail("Expected reply timeout")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .timeout)
            XCTAssertTrue(error.retryable)
        }

        do {
            _ = try await control.resume(
                peripheralID: "peripheral-1",
                request: Self.resumeRequest()
            )
            XCTFail("Expected uncertain ownership to fail closed")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .uploadOwnershipUnknown)
        }

        await control.resetAfterConfirmedDisconnect()
        await probe.resumeUnsubscribe()
    }

    func testCallerCancellationAbortsAndConcurrentOwnerIsRejected() async throws {
        let probe = TransferControlProbe(notifications: [])
        let control = try Self.control(probe)
        let first = Task.detached { @Sendable () async throws -> Void in
            _ = try await control.start(
                peripheralID: "peripheral-1",
                request: Self.startRequest(),
                replyTimeoutNanoseconds: 1_000_000_000
            )
        }
        try await Self.waitUntil { await probe.hasFrame(code: 0x20) }

        do {
            _ = try await control.resume(
                peripheralID: "peripheral-1",
                request: Self.resumeRequest()
            )
            XCTFail("Expected concurrent transfer-control ownership to be rejected")
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .operationInProgress)
        }

        first.cancel()
        do {
            try await first.value
            XCTFail("Expected caller cancellation")
        } catch is CancellationError {
            // Expected.
        }

        let snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.frames.map(\.first), [0x20, 0x24])
        XCTAssertEqual(snapshot.calls.last, .unsubscribe)
    }

    private static let transportSessionID: UInt64 = 0x0000_1122_3344_5566
    private static let uploadSessionID = UUID(
        uuidString: "10111213-1415-1617-1819-1a1b1c1d1e1f"
    )!
    private static let recordingUUID = "00112233-4455-6677-8899-aabbccddeeff"
    private static let prefix = data(
        "e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c77"
    )
    private static let ciphertextSHA256 = data(
        "287ad0258b5465b48757afe5f6980b7089fea7cb7520dc2db6d2fc9fd4fbfd1b"
    )

    private static func startRequest() -> EncryptedUploadV2StartRequestValue {
        EncryptedUploadV2StartRequestValue(
            transportSessionID: transportSessionID,
            uploadSessionID: uploadSessionID,
            recordingUUID: recordingUUID,
            recordingGeneration: 9,
            authorizationSHA256: data(
                "d1d0f59c9251cb91f193aeca65c0340dce4bfc536faaba3f24dc89fa24d9eb44"
            ),
            expectedCiphertextLength: 330,
            expectedCiphertextSHA256: ciphertextSHA256,
            expectedCheckpointIntervalBlocks: 8,
            checkpointRevision: 0,
            nextCiphertextOffset: 0,
            prefixSHA256: data(
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            ),
            windowPackets: 16,
            dataPayloadBytes: 244
        )
    }

    private static func resumeRequest() -> EncryptedUploadV2ResumeRequestValue {
        EncryptedUploadV2ResumeRequestValue(
            transportSessionID: transportSessionID,
            uploadSessionID: uploadSessionID,
            recordingUUID: recordingUUID,
            recordingGeneration: 9,
            checkpointRevision: 3,
            nextCiphertextOffset: 64,
            prefixSHA256: prefix,
            windowPackets: 16,
            dataPayloadBytes: 244
        )
    }

    private static func resumeValue() -> EncryptedUploadV2ResumeValue {
        EncryptedUploadV2ResumeValue(
            transportSessionID: transportSessionID,
            uploadSessionID: uploadSessionID,
            recordingUUID: recordingUUID,
            recordingGeneration: 9,
            checkpointRevision: 3,
            nextCiphertextOffset: 64,
            prefixSHA256: prefix,
            windowPackets: 16,
            dataPayloadBytes: 244
        )
    }

    private static func startAcknowledgement() -> Data {
        data(
            "400200006655443322110000101112131415161718191a1b1c1d1e1f00112233445566778899aabbccddeeff090000004a01000000000000287ad0258b5465b48757afe5f6980b7089fea7cb7520dc2db6d2fc9fd4fbfd1b1000f40008000000000000000000000000000000e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )
    }

    private static func resumeAccepted() -> Data {
        data(
            "450200006655443322110000101112131415161718191a1b1c1d1e1f00112233445566778899aabbccddeeff09000000030000004000000000000000e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c771000f400"
        )
    }

    private static func resumeRejected() -> Data {
        var value = data(
            "4602000066554433221100000f000000030000004000000000000000e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c77"
        )
        value.replaceSubrange(16..<20, with: u32(2))
        value.replaceSubrange(20..<28, with: u64(32))
        value.replaceSubrange(28..<60, with: Data(repeating: 0x11, count: 32))
        return value
    }

    private static func transferError(
        failedMessageType: UInt8,
        checkpointRevision: UInt32
    ) -> Data {
        var value = Data([
            0x4F, 0x02, 0x00, 0x00,
            0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x00, 0x00,
            0x0F, 0x00, failedMessageType, 0x00,
            0x00, 0x00, 0x00, 0x00,
        ])
        value.replaceSubrange(16..<20, with: u32(checkpointRevision))
        return value
    }

    private static func control(
        _ probe: TransferControlProbe
    ) throws -> EncryptedUploadV2TransferControl {
        EncryptedUploadV2TransferControl(
            mapper: try CoreModelMapper(),
            subscribe: { try await probe.subscribe(peripheralID: $0) },
            write: { await probe.write(peripheralID: $0, data: $1) },
            unsubscribe: { try await probe.unsubscribe(peripheralID: $0) }
        )
    }

    private static func data(_ hex: String) -> Data {
        Data(stride(from: 0, to: hex.count, by: 2).map { index in
            let start = hex.index(hex.startIndex, offsetBy: index)
            let end = hex.index(start, offsetBy: 2)
            return UInt8(hex[start..<end], radix: 16)!
        })
    }

    private static func u32(_ value: UInt32) -> Data {
        Data((0..<4).map { UInt8(truncatingIfNeeded: value >> UInt32($0 * 8)) })
    }

    private static func u64(_ value: UInt64) -> Data {
        Data((0..<8).map { UInt8(truncatingIfNeeded: value >> UInt64($0 * 8)) })
    }

    private static func waitUntil(
        timeoutNanoseconds: UInt64 = 500_000_000,
        condition: @escaping @Sendable () async -> Bool
    ) async throws {
        let deadline = ContinuousClock.now + .nanoseconds(Int64(timeoutNanoseconds))
        while !(await condition()) {
            if ContinuousClock.now >= deadline {
                throw BotaSDKError(
                    code: .timeout,
                    operation: .transferRecording,
                    retryable: true,
                    detail: "test probe timed out"
                )
            }
            await Task.yield()
        }
    }
}

private enum TransferControlCall: Equatable {
    case subscribe
    case write
    case unsubscribe
}

private actor TransferControlProbe {
    private let notifications: [Data]
    private var suspendUnsubscribe: Bool
    private var notificationContinuation: AsyncThrowingStream<Data, Error>.Continuation?
    private var unsubscribeContinuation: CheckedContinuation<Void, Error>?
    private var calls: [TransferControlCall] = []
    private var frames: [Data] = []

    init(notifications: [Data], suspendUnsubscribe: Bool = false) {
        self.notifications = notifications
        self.suspendUnsubscribe = suspendUnsubscribe
    }

    func subscribe(peripheralID: String) throws -> AsyncThrowingStream<Data, Error> {
        calls.append(.subscribe)
        return AsyncThrowingStream { notificationContinuation = $0 }
    }

    func write(peripheralID: String, data: Data) {
        calls.append(.write)
        frames.append(data)
        guard data.first != 0x24 else { return }
        notifications.forEach { notificationContinuation?.yield($0) }
        if !notifications.isEmpty { notificationContinuation?.finish() }
    }

    func unsubscribe(peripheralID: String) async throws {
        calls.append(.unsubscribe)
        if suspendUnsubscribe {
            try await withCheckedThrowingContinuation { unsubscribeContinuation = $0 }
        }
        notificationContinuation?.finish()
        notificationContinuation = nil
    }

    func resumeUnsubscribe() {
        suspendUnsubscribe = false
        unsubscribeContinuation?.resume()
        unsubscribeContinuation = nil
    }

    func hasFrame(code: UInt8) -> Bool {
        frames.contains { $0.first == code }
    }

    func snapshot() -> (calls: [TransferControlCall], frames: [Data]) {
        (calls, frames)
    }
}
