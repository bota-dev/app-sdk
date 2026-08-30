import BotaDeviceSDKC
import Foundation
import XCTest

@testable import BotaDeviceSDK

final class RecordingManagerTests: XCTestCase {
    func testListSubscribesBeforeCommandAndUsesSharedEncryptedRecordingDecoder() async throws {
        let data = Self.hex("a1b2c3d401000000000000000000000000f153650c000400")
        let runner = TransferWorkflowRunner { _ in [] }
        let recorder = TransferFacadeRecorder()
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(
            runner: runner,
            recorder: recorder,
            notificationData: data
        ))

        let recordings = try await manager.listRecordings(transferDevice())

        XCTAssertEqual(recordings.count, 1)
        XCTAssertTrue(recordings[0].isEncrypted)
        let subscriptions = await recorder.subscriptions
        let writes = await recorder.writes
        XCTAssertEqual(subscriptions, [BotaBluetoothUUIDs.recordingList])
        XCTAssertEqual(writes.map(\.data), [Data([1])])
    }

    func testTransferMapsProgressAndCompletesWithNativeFile() async throws {
        let runner = TransferWorkflowRunner { _ in [
            transferNotification(
                UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_PROGRESS),
                operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_TRANSFER_RECORDING),
                fields: [
                    .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMPLETED_UNITS), value: 512),
                    .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TOTAL_UNITS), value: 1024),
                ]
            ),
            transferCompleted(operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_TRANSFER_RECORDING)),
        ] }
        let recorder = TransferFacadeRecorder()
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(runner: runner, recorder: recorder))
        let recording = DeviceRecording(
            uuid: "00112233-4455-6677-8899-aabbccddeeff",
            startedAt: Date(timeIntervalSince1970: 0),
            durationMs: 1,
            fileSizeBytes: 1024,
            codec: .known(.opus16k),
            isEncrypted: true
        )

        let stream = try await manager.syncRecording(transferDevice(), recording: recording)
        var values: [RecordingSyncEvent] = []
        for try await value in stream { values.append(value) }

        XCTAssertEqual(values.first, .progress(.init(completedBytes: 512, totalBytes: 1024)))
        guard case let .completed(fileURL) = values.last else { return XCTFail("expected file completion") }
        XCTAssertEqual(fileURL.pathExtension, "recording")
        let commands = await runner.commands
        XCTAssertEqual(commands.first?.kind, UInt32(BOTA_DEVICE_SDK_V1_COMMAND_TRANSFER_RECORDING))
    }

    func testUploadOwnershipYieldsFallbackOnlyFromCoreNotification() async throws {
        let runner = TransferWorkflowRunner { _ in [
            transferNotification(
                UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_BLE_FALLBACK_READY),
                operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_UPLOAD),
                fields: [
                    .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RECORDING_UUID), value: "00112233445566778899aabbccddeeff"),
                    .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_UPLOAD_ID), value: "upload-1"),
                    .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DESTINATION_ID), value: "destination-1"),
                ]
            ),
            transferCompleted(operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_UPLOAD)),
        ] }
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(runner: runner, recorder: TransferFacadeRecorder()))

        let stream = try await manager.observeUploadOwnership(
            transferDevice(),
            recordingUUID: "00112233445566778899aabbccddeeff",
            uploadID: "upload-1",
            destinationID: "destination-1"
        )
        var values: [UploadOwnershipEvent] = []
        for try await value in stream { values.append(value) }

        XCTAssertEqual(values.last, .result(.bluetoothFallback(
            recordingUUID: "00112233445566778899aabbccddeeff",
            uploadID: "upload-1",
            destinationID: "destination-1"
        )))
    }

    private static func hex(_ value: String) -> Data {
        Data(stride(from: 0, to: value.count, by: 2).map { offset in
            let start = value.index(value.startIndex, offsetBy: offset)
            return UInt8(value[start..<value.index(start, offsetBy: 2)], radix: 16)!
        })
    }
}
