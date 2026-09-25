import BotaAppSDK
import XCTest
@testable import BotaDeviceSDKAppleAdapter

final class BotaDeviceSDKAppleLogsTests: XCTestCase {
    func testDiagnosticReadDoesNotAcknowledgeAndPreservesEventIDs() async throws {
        let client = TestAppleLogClient()
        let logs = BotaDeviceSDKAppleLogs(client: client)
        let device = ConnectedDevice(
            id: "selected", serialNumber: "EVFXXW67KP", deviceType: .botaPin,
            firmwareVersion: "1.0.11", isProvisioned: true,
            connectionState: .connected, mtu: 247
        )
        let batch = try await logs.readDiagnosticEvents(device)
        let beforeAck = await client.acknowledgements()
        XCTAssertTrue(beforeAck.isEmpty)
        XCTAssertEqual(batch.events.first?.eventId, "ffffffffffffffff")
        let payload = diagnosticBatchPayload(batch)
        let event = try XCTUnwrap((payload["events"] as? [[String: Any]])?.first)
        XCTAssertEqual(event["event_id"] as? String, "ffffffffffffffff")
        XCTAssertEqual(event["uptime_ms"] as? UInt32, .max)
        try await logs.acknowledgeDiagnosticEvents(device, acceptedEventIds: ["ffffffffffffffff"])
        let afterAck = await client.acknowledgements()
        XCTAssertEqual(afterAck, ["ffffffffffffffff"])
    }

    func testLogStreamEmitsSanitizedLinesAndOwnsStop() async throws {
        let client = TestAppleLogClient()
        let logs = BotaDeviceSDKAppleLogs(client: client)
        let capture = DeviceLogCapture()

        try await logs.start(
            ConnectedDevice(
                id: "selected",
                serialNumber: "EVFXXW67KP",
                deviceType: .botaPin,
                firmwareVersion: "1.0.11",
                isProvisioned: true,
                connectionState: .connected,
                mtu: 247
            )
        ) { line in
            Task { await capture.append(line) }
        }

        for _ in 0 ..< 100 {
            if !(await capture.snapshot()).isEmpty { break }
            await Task.yield()
        }
        let lines = await capture.snapshot()
        XCTAssertEqual(
            lines,
            [.init(message: "boot pass", isBacklog: true)]
        )
        await logs.stop()
        let stopped = await client.wasStopped()
        XCTAssertTrue(stopped)
    }
}

private actor DeviceLogCapture {
    private var values: [DeviceLogLine] = []

    func append(_ value: DeviceLogLine) {
        values.append(value)
    }

    func snapshot() -> [DeviceLogLine] {
        values
    }
}

private actor TestAppleLogClient: BotaDeviceSDKAppleLogClient {
    private var stopped = false
    private var acceptedIDs: [String] = []

    func readDiagnosticEvents(_ device: ConnectedDevice) async throws -> DeviceDiagnosticsBatch {
        DeviceDiagnosticsBatch(schemaVersion: 1, events: [DeviceDiagnosticEvent(
            eventId: "ffffffffffffffff", eventType: "crash", reasonCode: "exception",
            uptimeMs: .max, signature: "0123456789abcdef", firmwareBuildId: "1.0.11",
            subsystem: "system", stateBeforeEvent: "idle"
        )])
    }

    func acknowledgeDiagnosticEvents(_ device: ConnectedDevice, acceptedEventIds: [String]) async throws {
        acceptedIDs.append(contentsOf: acceptedEventIds)
    }

    func acknowledgements() -> [String] { acceptedIDs }

    func streamLogs(
        _ device: ConnectedDevice
    ) async throws -> AsyncThrowingStream<DeviceLogLine, Error> {
        let pair = AsyncThrowingStream<DeviceLogLine, Error>.makeStream()
        pair.continuation.yield(.init(message: "boot pass", isBacklog: true))
        return pair.stream
    }

    func stop() async throws {
        stopped = true
    }

    func wasStopped() -> Bool {
        stopped
    }
}
