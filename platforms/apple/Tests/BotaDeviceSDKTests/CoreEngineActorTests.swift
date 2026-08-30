import BotaDeviceSDKC
import Foundation
import XCTest

@testable import BotaDeviceSDK

final class CoreEngineActorTests: XCTestCase {
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
