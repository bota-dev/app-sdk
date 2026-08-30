import BotaDeviceSDKC
import XCTest

@testable import BotaDeviceSDK

final class DeviceLogManagerTests: XCTestCase {
    func testStreamYieldsOnlySanitizedCoreLogNotifications() async throws {
        let runner = TransferWorkflowRunner { _ in [
            transferNotification(
                UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_DEVICE_LOG),
                operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_READ_DEVICE_LOGS),
                fields: [
                    .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_LOG_MESSAGE), value: "boot pass"),
                    .bool(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_IS_BACKLOG), value: true),
                ]
            ),
            transferCompleted(operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_READ_DEVICE_LOGS)),
        ] }
        let manager = DeviceLogManager()
        await manager.attach(await transferRuntime(runner: runner, recorder: TransferFacadeRecorder()))

        let stream = try await manager.streamLogs(transferDevice())
        var lines: [DeviceLogLine] = []
        for try await line in stream { lines.append(line) }

        XCTAssertEqual(lines, [.init(message: "boot pass", isBacklog: true)])
        let commands = await runner.commands
        XCTAssertEqual(commands.first?.kind, UInt32(BOTA_DEVICE_SDK_V1_COMMAND_READ_DEVICE_LOGS))
    }
}
