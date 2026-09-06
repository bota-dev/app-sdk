import BotaDeviceSDKC
import Foundation
import XCTest

@testable import BotaAppleSDK

final class CoreEngineActorTests: XCTestCase {
    func testRunWaitsForTheABIWorkflowOwnerBeforeReturningItsStream() async throws {
        let abi = TestCoreAbi()
        let engine = CoreEngineActor(abi: try CoreAbiClient(abi: abi), host: FakeCoreHost(handler: { _ in [] }))
        let startEntered = expectation(description: "ABI start entered")
        let runReturned = expectation(description: "run returned before ABI start")
        runReturned.isInverted = true
        abi.startEntered = { startEntered.fulfill() }
        abi.startGate = DispatchSemaphore(value: 0)

        let run = Task {
            let stream = await engine.run(
                .discoverDevices(timeoutMilliseconds: 10_000, allowDuplicates: false),
                capabilities: [.bluetooth, .timer]
            )
            _ = stream
            runReturned.fulfill()
        }

        await fulfillment(of: [startEntered, runReturned], timeout: 0.1)
        abi.resumeStart()
        await run.value

        XCTAssertEqual(abi.startCount, 1)
    }

    func testRunsOneWorkflowWithOrderedNotificationsAndMonotonicRequests() async throws {
        let host = FakeCoreHost(handler: FakeCoreHost.discoveryHandler())
        let engine = CoreEngineActor(abi: try CoreAbiClient(), host: host)

        let stream = await engine.run(
            .discoverDevices(timeoutMilliseconds: 10, allowDuplicates: false),
            capabilities: [.bluetooth, .timer]
        )
        var notifications: [CoreNotificationKind] = []
        for try await notification in stream {
            notifications.append(notification.kind)
        }

        XCTAssertEqual(notifications, [.started, .deviceDiscovered, .completed])
        let effects = await host.effects
        XCTAssertEqual(effects.map(\.kind), [
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_START_SCAN),
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_TIMER_SCHEDULE),
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_STOP_SCAN),
        ])
        XCTAssertEqual(effects.map(\.requestID), effects.map(\.requestID).sorted())
        XCTAssertEqual(Set(effects.map(\.cancellationID)).count, 1)
    }

    func testSecondCommandReachesCoreAndReportsOperationInProgress() async throws {
        let host = FakeCoreHost(handler: { _ in [] })
        let engine = CoreEngineActor(abi: try CoreAbiClient(), host: host)
        let first = await engine.run(
            .discoverDevices(timeoutMilliseconds: 10_000, allowDuplicates: false),
            capabilities: [.bluetooth, .timer]
        )
        var firstIterator = first.makeAsyncIterator()
        let firstNotification = try await firstIterator.next()
        XCTAssertEqual(firstNotification?.kind, .started)

        let second = await engine.run(
            .discoverDevices(timeoutMilliseconds: 10_000, allowDuplicates: false),
            capabilities: [.bluetooth, .timer]
        )
        do {
            for try await _ in second {}
            XCTFail("second command should fail")
        } catch let error as CoreError {
            XCTAssertEqual(error.code, UInt32(BOTA_DEVICE_SDK_V1_ERROR_OPERATION_IN_PROGRESS))
        }
    }

    func testCancellationOnlyEndsTheMatchingWorkflow() async throws {
        let host = FakeCoreHost(handler: { _ in [] })
        let engine = CoreEngineActor(abi: try CoreAbiClient(), host: host)
        let cancellationID = UUID(uuidString: "01010101-0101-0101-0101-010101010101")!
        let stream = await engine.run(
            .discoverDevices(
                timeoutMilliseconds: 10_000,
                allowDuplicates: false,
                cancellationID: cancellationID
            ),
            capabilities: [.bluetooth, .timer]
        )
        let collector = Task {
            var values: [CoreNotificationKind] = []
            for try await notification in stream {
                values.append(notification.kind)
            }
            return values
        }
        await host.waitForEffects(2)

        try await engine.cancel(cancellationID)

        let collected = try await collector.value
        XCTAssertEqual(collected, [.started, .cancelled])
        do {
            try await engine.cancel(UUID())
            XCTFail("unrelated cancellation should fail")
        } catch let error as CoreError {
            XCTAssertEqual(error.code, UInt32(BOTA_DEVICE_SDK_V1_ERROR_UNEXPECTED_EVENT))
        }
    }

    func testImmediateCancellationDoesNotStartQueuedStartEffectsAfterHostCancellation() async throws {
        let host = ImmediateCancellationHost()
        let engine = CoreEngineActor(abi: try CoreAbiClient(), host: host)
        let cancellationID = UUID(uuidString: "02020202-0202-0202-0202-020202020202")!

        let stream = await engine.run(
            .discoverDevices(
                timeoutMilliseconds: 10_000,
                allowDuplicates: false,
                cancellationID: cancellationID
            ),
            capabilities: [.bluetooth, .timer]
        )
        try await engine.cancel(cancellationID)

        var notifications: [CoreNotificationKind] = []
        for try await notification in stream {
            notifications.append(notification.kind)
        }

        XCTAssertEqual(notifications, [.started, .cancelled])
        let timeline = await host.timeline
        XCTAssertEqual(timeline, [
            .effect(UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_START_SCAN)),
            .effect(UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_TIMER_SCHEDULE)),
            .cancel,
            .effect(UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_STOP_SCAN)),
            .effect(UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_TIMER_CANCEL)),
        ])

        let replacementCancellationID = UUID(uuidString: "03030303-0303-0303-0303-030303030303")!
        let replacement = await engine.run(
            .discoverDevices(
                timeoutMilliseconds: 10_000,
                allowDuplicates: false,
                cancellationID: replacementCancellationID
            ),
            capabilities: [.bluetooth, .timer]
        )
        var iterator = replacement.makeAsyncIterator()
        let replacementStarted = try await iterator.next()
        XCTAssertEqual(replacementStarted?.kind, .started)
        try await engine.cancel(replacementCancellationID)
    }

    func testRejectsAStaleHostEventWithoutLosingTheOwner() async throws {
        let host = FakeCoreHost(handler: FakeCoreHost.discoveryHandler(staleFirst: true))
        let engine = CoreEngineActor(abi: try CoreAbiClient(), host: host)

        let stream = await engine.run(
            .discoverDevices(timeoutMilliseconds: 10, allowDuplicates: false),
            capabilities: [.bluetooth, .timer]
        )
        var notifications: [CoreNotificationKind] = []
        for try await notification in stream {
            notifications.append(notification.kind)
        }

        XCTAssertEqual(notifications, [.started, .deviceDiscovered, .completed])
    }

    func testOpenScanStreamDoesNotBlockTimerAndStopEffects() async throws {
        let host = ConcurrentDiscoveryHost()
        let engine = CoreEngineActor(abi: try CoreAbiClient(), host: host)
        let completed = expectation(description: "discovery completed")
        let stream = await engine.run(
            .discoverDevices(timeoutMilliseconds: 1, allowDuplicates: false),
            capabilities: [.bluetooth, .timer]
        )
        let collector = Task {
            for try await notification in stream where notification.kind == .completed {
                completed.fulfill()
            }
        }

        await fulfillment(of: [completed], timeout: 0.5)
        collector.cancel()
        await host.finishScan()
    }
}

private actor ImmediateCancellationHost: CoreHost {
    enum Event: Equatable {
        case effect(UInt32)
        case cancel
    }

    private(set) var timeline: [Event] = []

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEvent, Error> {
        timeline.append(.effect(effect.kind))
        return AsyncThrowingStream { $0.finish() }
    }

    func cancel(_ cancellationID: CoreCancellationID) async {
        timeline.append(.cancel)
    }
}

private actor ConcurrentDiscoveryHost: CoreHost {
    private var scanContinuation: AsyncThrowingStream<CoreHostEvent, Error>.Continuation?

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEvent, Error> {
        switch effect.kind {
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_START_SCAN):
            let pair = AsyncThrowingStream<CoreHostEvent, Error>.makeStream()
            scanContinuation = pair.continuation
            return pair.stream
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_TIMER_SCHEDULE):
            return AsyncThrowingStream { continuation in
                continuation.yield(CoreHostEvent(
                    effect: effect,
                    kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_TIMER_FIRED),
                    fields: [.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TIMER_ID), value: 1)]
                ))
                continuation.finish()
            }
        case UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_BLE_STOP_SCAN):
            scanContinuation?.finish()
            scanContinuation = nil
            return AsyncThrowingStream { continuation in
                continuation.yield(CoreHostEvent(
                    effect: effect,
                    kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_SCAN_STOPPED)
                ))
                continuation.finish()
            }
        default:
            return AsyncThrowingStream { $0.finish() }
        }
    }

    func finishScan() {
        scanContinuation?.finish()
        scanContinuation = nil
    }
}
