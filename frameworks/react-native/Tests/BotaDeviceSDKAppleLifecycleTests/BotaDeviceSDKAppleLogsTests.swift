import BotaAppleSDK
import XCTest
@testable import BotaDeviceSDKAppleAdapter

final class BotaDeviceSDKAppleLogsTests: XCTestCase {
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
