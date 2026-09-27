import Foundation
import XCTest

@testable import BotaAppSDK

final class DeviceDiagnosticsTests: XCTestCase {
    func testReadSubscribesBeforeListAndDoesNotAcknowledge() async throws {
        let fixture = DiagnosticsFixture()
        let manager = DeviceLogManager()
        await manager.attach(await fixture.runtime())
        let batch = try await manager.readDiagnosticEvents(transferDevice())
        XCTAssertEqual(batch, DeviceDiagnosticsBatch(schemaVersion: 1, events: []))
        let actions = await fixture.actions
        XCTAssertEqual(actions, ["subscribe", "list", "unsubscribe"])
    }

    func testAcknowledgementPrevalidatesEveryIdBeforeWriting() async throws {
        let fixture = DiagnosticsFixture()
        let manager = DeviceLogManager()
        await manager.attach(await fixture.runtime())
        do {
            try await manager.acknowledgeDiagnosticEvents(
                transferDevice(), acceptedEventIds: ["ffffffffffffffff", "BAD"]
            )
            XCTFail("invalid trailing ID must reject the whole request")
        } catch {}
        let actions = await fixture.actions
        XCTAssertTrue(actions.isEmpty)
        try await manager.acknowledgeDiagnosticEvents(
            transferDevice(), acceptedEventIds: ["ffffffffffffffff", "8000000000000001"]
        )
        let writes = await fixture.actions
        XCTAssertEqual(writes, ["ack:ffffffffffffffff", "ack:8000000000000001"])
    }

    func testReadBlocksLogsAndCancellationUnsubscribesBeforeNextRead() async throws {
        let fixture = DiagnosticsFixture(hold: true)
        let manager = DeviceLogManager()
        await manager.attach(await fixture.runtime())
        let read = Task { try await manager.readDiagnosticEvents(transferDevice()) }
        await fixture.waitForList()
        do {
            _ = try await manager.streamLogs(transferDevice())
            XCTFail("diagnostics must exclude logs")
        } catch let error as BotaSDKError { XCTAssertEqual(error.code, .operationInProgress) }
        do {
            try await manager.acknowledgeDiagnosticEvents(transferDevice(), acceptedEventIds: ["ffffffffffffffff"])
            XCTFail("diagnostics must exclude acknowledgements")
        } catch let error as BotaSDKError { XCTAssertEqual(error.code, .operationInProgress) }
        read.cancel()
        _ = await read.result
        let actions = await fixture.actions
        XCTAssertEqual(actions, ["subscribe", "list", "unsubscribe"])
        await manager.detach()
    }

    func testTimeoutCleansUpAndReleasesOwnership() async throws {
        let fixture = DiagnosticsFixture(hold: true)
        let manager = DeviceLogManager(diagnosticTimeoutMilliseconds: 10)
        await manager.attach(await fixture.runtime())
        do {
            _ = try await manager.readDiagnosticEvents(transferDevice())
            XCTFail("read must time out")
        } catch let error as BotaSDKError { XCTAssertEqual(error.code, .timeout) }
        try await manager.acknowledgeDiagnosticEvents(transferDevice(), acceptedEventIds: [])
        let actions = await fixture.actions
        XCTAssertEqual(actions, ["subscribe", "list", "unsubscribe"])
    }

    func testDetachCancelsReadWithoutTouchingReplacementRuntime() async throws {
        let old = DiagnosticsFixture(hold: true)
        let replacement = DiagnosticsFixture()
        let manager = DeviceLogManager()
        await manager.attach(await old.runtime())
        let read = Task { try await manager.readDiagnosticEvents(transferDevice()) }
        await old.waitForList()
        await manager.detach()
        await manager.attach(await replacement.runtime())
        _ = await read.result
        _ = try await manager.readDiagnosticEvents(transferDevice())
        let oldActions = await old.actions
        let newActions = await replacement.actions
        XCTAssertEqual(oldActions, ["subscribe", "list", "unsubscribe"])
        XCTAssertEqual(newActions, ["subscribe", "list", "unsubscribe"])
    }

    func testFailedUnsubscribeRetainsOwnershipUntilDetach() async throws {
        let fixture = DiagnosticsFixture(failUnsubscribe: true)
        let manager = DeviceLogManager()
        await manager.attach(await fixture.runtime())
        do { _ = try await manager.readDiagnosticEvents(transferDevice()); XCTFail("cleanup failure") } catch {}
        do {
            try await manager.acknowledgeDiagnosticEvents(transferDevice(), acceptedEventIds: ["ffffffffffffffff"])
            XCTFail("unconfirmed cleanup must retain ownership")
        } catch let error as BotaSDKError { XCTAssertEqual(error.code, .operationInProgress) }
        await manager.detach()
    }

    func testTimeoutWithFailedUnsubscribeRetainsManagerAndRuntimeOwnership() async throws {
        let fixture = DiagnosticsFixture(hold: true, failUnsubscribe: true)
        let manager = DeviceLogManager()
        let runtime = await fixture.runtime(delay: { _ in await fixture.waitForList() })
        await manager.attach(runtime)
        do { _ = try await manager.readDiagnosticEvents(transferDevice()); XCTFail("read must fail") } catch {}
        let actions = await fixture.actions
        XCTAssertEqual(actions, ["subscribe", "list", "unsubscribe"])
        do {
            try await manager.acknowledgeDiagnosticEvents(transferDevice(), acceptedEventIds: ["ffffffffffffffff"])
            XCTFail("timeout cannot release unconfirmed diagnostics cleanup")
        } catch let error as BotaSDKError { XCTAssertEqual(error.code, .operationInProgress) }
        do { _ = try await manager.streamLogs(transferDevice()); XCTFail("timeout cannot permit logs") }
        catch let error as BotaSDKError { XCTAssertEqual(error.code, .operationInProgress) }
        let otherOwner = UUID()
        do {
            try await runtime.operations.begin(otherOwner, operation: .readDeviceLogs)
            XCTFail("timeout cannot release the shared runtime owner")
            await runtime.operations.end(otherOwner)
        } catch let error as BotaSDKError { XCTAssertEqual(error.code, .operationInProgress) }
        let finalActions = await fixture.actions
        XCTAssertEqual(finalActions, ["subscribe", "list", "unsubscribe"])
        await manager.detach()
    }

    func testCancellationAndStopWithFailedUnsubscribeRetainOwnership() async throws {
        for useStop in [false, true] {
            let fixture = DiagnosticsFixture(hold: true, failUnsubscribe: true)
            let manager = DeviceLogManager()
            let runtime = await fixture.runtime()
            await manager.attach(runtime)
            let read = Task { try await manager.readDiagnosticEvents(transferDevice()) }
            await fixture.waitForList()
            if useStop { try? await manager.stop() } else { read.cancel() }
            _ = await read.result
            do {
                try await manager.acknowledgeDiagnosticEvents(transferDevice(), acceptedEventIds: ["ffffffffffffffff"])
                XCTFail("cancelled read cannot release unconfirmed cleanup")
            } catch let error as BotaSDKError { XCTAssertEqual(error.code, .operationInProgress) }
            do { _ = try await manager.streamLogs(transferDevice()); XCTFail("cancelled read cannot permit logs") }
            catch let error as BotaSDKError { XCTAssertEqual(error.code, .operationInProgress) }
            let otherOwner = UUID()
            do {
                try await runtime.operations.begin(otherOwner, operation: .readDeviceLogs)
                XCTFail("cancelled read cannot release the shared owner")
                await runtime.operations.end(otherOwner)
            } catch let error as BotaSDKError { XCTAssertEqual(error.code, .operationInProgress) }
            let actions = await fixture.actions
            XCTAssertEqual(actions, ["subscribe", "list", "unsubscribe"])
            await manager.detach()
        }
    }

    func testPendingLogStartupExcludesDiagnosticsThroughStopSettlement() async throws {
        let runner = PendingDiagnosticLogRunner()
        let fixture = DiagnosticsFixture()
        let manager = DeviceLogManager()
        await manager.attach(await fixture.runtime(runner: runner))
        _ = try await manager.streamLogs(transferDevice())
        await runner.waitUntilStarted()
        let stop = Task { try await manager.stop() }
        do { _ = try await manager.readDiagnosticEvents(transferDevice()); XCTFail("pending logs") }
        catch let error as BotaSDKError { XCTAssertEqual(error.code, .operationInProgress) }
        await runner.release()
        try await stop.value
        _ = try await manager.readDiagnosticEvents(transferDevice())
        let cancellations = await runner.cancellations
        XCTAssertEqual(cancellations, 1)
    }

    func testRuntimeReplacementDuringSubscribeCancelsBeforeListAndUsesOldCleanup() async throws {
        let old = DiagnosticsFixture()
        let replacement = DiagnosticsFixture()
        let manager = DeviceLogManager()
        let replacementRuntime = await replacement.runtime()
        await old.setOnSubscribe { await manager.attach(replacementRuntime) }
        await manager.attach(await old.runtime())
        do { _ = try await manager.readDiagnosticEvents(transferDevice()); XCTFail("replaced read") } catch {}
        _ = try await manager.readDiagnosticEvents(transferDevice())
        let oldActions = await old.actions
        let newActions = await replacement.actions
        XCTAssertEqual(oldActions, ["subscribe", "unsubscribe"])
        XCTAssertEqual(newActions, ["subscribe", "list", "unsubscribe"])
    }

    func testAuthorizationRejectsReadAndAckBeforeAnyBluetoothIO() async throws {
        let fixture = DiagnosticsFixture()
        let manager = DeviceLogManager()
        await manager.attach(await fixture.runtime(authorize: { operation in
            XCTAssertEqual(operation, .readDeviceLogs)
            throw BotaSDKError(code: .featureUnavailable, operation: operation, retryable: false, detail: "denied")
        }))
        do { _ = try await manager.readDiagnosticEvents(transferDevice()); XCTFail("denied read") } catch {}
        do {
            try await manager.acknowledgeDiagnosticEvents(transferDevice(), acceptedEventIds: ["ffffffffffffffff"])
            XCTFail("denied ack")
        } catch {}
        let actions = await fixture.actions
        XCTAssertTrue(actions.isEmpty)
    }

    func testSameIdentityConnectionReplacementDuringSubscribeCannotListOrUnsubscribeReplacement() async throws {
        let fixture = DiagnosticsFixture()
        let manager = DeviceLogManager()
        let runtime = await fixture.runtime()
        await fixture.setOnSubscribe { await runtime.connection.set(transferDevice()) }
        await manager.attach(runtime)
        do { _ = try await manager.readDiagnosticEvents(transferDevice()); XCTFail("replaced connection") } catch {}
        let actions = await fixture.actions
        XCTAssertEqual(actions, ["subscribe"])
    }

    func testSameIdentityConnectionReplacementBetweenAcksStopsRemainingWrites() async throws {
        let fixture = DiagnosticsFixture()
        let manager = DeviceLogManager()
        let runtime = await fixture.runtime()
        await fixture.setOnWrite { await runtime.connection.set(transferDevice()) }
        await manager.attach(runtime)
        do {
            try await manager.acknowledgeDiagnosticEvents(transferDevice(), acceptedEventIds: ["ffffffffffffffff", "8000000000000001"])
            XCTFail("replaced connection")
        } catch {}
        let actions = await fixture.actions
        XCTAssertEqual(actions, ["ack:ffffffffffffffff"])
    }
}

private actor DiagnosticsFixture {
    var actions: [String] = []
    private let hold: Bool
    private let failUnsubscribe: Bool
    private var continuation: AsyncThrowingStream<Data, Error>.Continuation?
    private var listed = false
    private var listWaiters: [CheckedContinuation<Void, Never>] = []
    private var onSubscribe: (@Sendable () async -> Void)?
    private var onWrite: (@Sendable () async -> Void)?

    init(hold: Bool = false, failUnsubscribe: Bool = false) {
        self.hold = hold
        self.failUnsubscribe = failUnsubscribe
    }

    func waitForList() async {
        if listed { return }
        await withCheckedContinuation { listWaiters.append($0) }
    }

    func setOnSubscribe(_ action: @escaping @Sendable () async -> Void) { onSubscribe = action }
    func setOnWrite(_ action: @escaping @Sendable () async -> Void) { onWrite = action }

    func runtime(
        runner: any CoreWorkflowRunning = TransferWorkflowRunner { _ in [] },
        authorize: @escaping @Sendable (BotaOperation) throws -> Void = { _ in },
        delay: @escaping @Sendable (UInt64) async throws -> Void = { milliseconds in
            try await Task.sleep(nanoseconds: milliseconds * 1_000_000)
        }
    ) async -> DeviceRuntime {
        let runtime = DeviceRuntime(
            engine: runner, capabilities: .all,
            authorize: authorize,
            disconnect: { _ in },
            directWrite: { _, _, _, data in await self.write(data) },
            directSubscribe: { _, _, _ in await self.subscribe() },
            directUnsubscribe: { _, _, _ in try await self.unsubscribe() },
            decodeDiagnosticEvents: { data in
                data.isEmpty ? nil : DeviceDiagnosticsBatch(schemaVersion: 1, events: [])
            },
            createDiagnosticCommand: { id in
                if let id {
                    guard id.count == 16, id.allSatisfy({ "0123456789abcdef".contains($0) }) else {
                        throw BotaSDKError(code: .invalidInput, operation: .encode, retryable: false, detail: "invalid ID")
                    }
                    return Data(id.utf8)
                }
                return Data()
            },
            delay: delay
        )
        await runtime.connection.set(transferDevice())
        return runtime
    }

    private func subscribe() async -> AsyncThrowingStream<Data, Error> {
        actions.append("subscribe")
        let pair = AsyncThrowingStream<Data, Error>.makeStream()
        continuation = pair.continuation
        await onSubscribe?()
        return pair.stream
    }

    private func write(_ data: Data) async {
        if data.isEmpty {
            actions.append("list")
            listed = true
            listWaiters.forEach { $0.resume() }
            listWaiters.removeAll()
            if !hold { continuation?.yield(Data([1])) }
        } else { actions.append("ack:\(String(decoding: data, as: UTF8.self))") }
        await onWrite?()
    }

    private func unsubscribe() throws {
        actions.append("unsubscribe")
        if failUnsubscribe { throw NativeHostError.missingResource("unsubscribe failed") }
        continuation?.finish()
        continuation = nil
    }
}

private actor PendingDiagnosticLogRunner: CoreWorkflowRunning {
    private var entered = false
    private var enteredWaiter: CheckedContinuation<Void, Never>?
    private var gate: CheckedContinuation<Void, Never>?
    private(set) var cancellations = 0

    func run(_ command: CoreCommand, capabilities: CoreCapabilities) async -> AsyncThrowingStream<CoreNotification, Error> {
        entered = true
        enteredWaiter?.resume()
        await withCheckedContinuation { gate = $0 }
        return AsyncThrowingStream { _ in }
    }

    func waitUntilStarted() async {
        if !entered { await withCheckedContinuation { enteredWaiter = $0 } }
    }

    func release() { gate?.resume(); gate = nil }
    func cancel(_ id: UUID) async throws { cancellations += 1 }
}
