import BotaDeviceSDKC
import Foundation
import XCTest

@testable import BotaDeviceSDK

final class OTAManagerTests: XCTestCase {
    func testFirmwareSourceStaysNativeAndProgressMapsCanonicalPhases() async throws {
        let runner = TransferWorkflowRunner { _ in [
            transferNotification(
                UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_FIRMWARE_PROGRESS),
                operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_UPDATE_FIRMWARE),
                fields: [
                    .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_FIRMWARE_PHASE), value: 1),
                    .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMPLETED_UNITS), value: 750),
                    .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TOTAL_UNITS), value: 4000),
                ]
            ),
            transferCompleted(operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_UPDATE_FIRMWARE)),
        ] }
        let recorder = TransferFacadeRecorder()
        let manager = OTAManager()
        await manager.attach(await transferRuntime(runner: runner, recorder: recorder))
        let image = FirmwareImage(
            version: "1.0.18",
            sizeBytes: 4000,
            crc32: 0x12345678,
            downloadID: 44,
            request: URLRequest(url: URL(string: "https://example.test/firmware")!)
        )

        let stream = try await manager.updateFirmware(transferDevice(), image: image)
        var values: [FirmwareUpdateProgress] = []
        for try await value in stream { values.append(value) }

        let registrations = await recorder.firmwareRegistrations
        let unregistrations = await recorder.firmwareUnregistrations
        XCTAssertEqual(values, [.init(phase: .downloading, completedBytes: 750, totalBytes: 4000)])
        XCTAssertEqual(registrations, [44])
        XCTAssertEqual(unregistrations, [44])
        let commands = await runner.commands
        XCTAssertEqual(commands.first?.kind, UInt32(BOTA_DEVICE_SDK_V1_COMMAND_UPDATE_FIRMWARE))
    }
}
