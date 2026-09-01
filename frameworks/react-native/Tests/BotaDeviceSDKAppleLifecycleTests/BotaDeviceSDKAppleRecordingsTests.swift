import BotaAppleSDK
import Foundation
import XCTest
@testable import BotaDeviceSDKAppleAdapter

final class BotaDeviceSDKAppleRecordingsTests: XCTestCase {
    func testRecordingListAndSyncKeepTransferBytesInNativeFile() async throws {
        let connected = ConnectedDevice(
            id: "selected",
            serialNumber: "EVFXXW67KP",
            deviceType: .botaPin,
            firmwareVersion: "1.0.11",
            isProvisioned: true,
            connectionState: .connected,
            mtu: 247
        )
        let recording = DeviceRecording(
            uuid: "recording-1",
            startedAt: Date(timeIntervalSince1970: 1_788_200_000),
            durationMs: 12_000,
            fileSizeBytes: 48_000,
            codec: .known(.opus16k),
            isEncrypted: true
        )
        let client = TestAppleRecordingClient(recording: recording)
        let recordings = BotaDeviceSDKAppleRecordings(client: client)
        let progress = RecordingProgressCapture()

        let listed = try await recordings.listRecordings(connected)
        XCTAssertEqual(listed, [recording])
        let result = try await recordings.syncRecording(
            connected,
            recording: recording,
            sinkID: "sink-1"
        ) { value in
            Task { await progress.append(value) }
        }

        XCTAssertEqual(result, .init(
            localPath: "/tmp/bota-recordings/recording-1.ogg",
            isE2EEncrypted: true,
            contentSHA256Hex: String(repeating: "5a", count: 32)
        ))
        let progressSnapshot = await progress.snapshot()
        XCTAssertEqual(
            progressSnapshot,
            [.init(completedBytes: 24_000, totalBytes: 48_000)]
        )
        let sinkIDs = await client.observedSinkIDs()
        XCTAssertEqual(sinkIDs, ["sink-1"])
        await recordings.cancelAll()
        let cancelled = await client.wasCancelled()
        XCTAssertTrue(cancelled)
    }

    func testUploadOwnershipReturnsNativeFallbackDecisionAndProgress() async throws {
        let connected = ConnectedDevice(
            id: "selected",
            serialNumber: "EVFXXW67KP",
            deviceType: .botaPin,
            firmwareVersion: "1.0.11",
            isProvisioned: true,
            connectionState: .connected,
            mtu: 247
        )
        let client = TestAppleRecordingClient(recording: DeviceRecording(
            uuid: "recording-1",
            startedAt: Date(timeIntervalSince1970: 1_788_200_000),
            durationMs: 12_000,
            fileSizeBytes: 48_000,
            codec: .known(.opus16k),
            isEncrypted: true
        ))
        let recordings = BotaDeviceSDKAppleRecordings(client: client)
        let progress = RecordingProgressCapture()

        let result = try await recordings.observeUploadOwnership(
            connected,
            recordingUUID: "recording-1",
            uploadID: "upload-1",
            destinationID: "destination-1"
        ) { value in
            Task { await progress.append(value) }
        }

        XCTAssertEqual(
            result,
            .bluetoothFallback(
                recordingUUID: "recording-1",
                uploadID: "upload-1",
                destinationID: "destination-1"
            )
        )
        let progressSnapshot = await progress.snapshot()
        XCTAssertEqual(
            progressSnapshot,
            [.init(completedBytes: 32_000, totalBytes: 48_000)]
        )
    }
}

private actor RecordingProgressCapture {
    private var values: [RecordingTransferProgress] = []

    func append(_ value: RecordingTransferProgress) {
        values.append(value)
    }

    func snapshot() -> [RecordingTransferProgress] {
        values
    }
}

private actor TestAppleRecordingClient: BotaDeviceSDKAppleRecordingClient {
    private let recording: DeviceRecording
    private var cancelled = false
    private var sinkIDs: [String] = []
    private var confirmedRecordingUUIDs: [String] = []

    init(recording: DeviceRecording) {
        self.recording = recording
    }

    func listRecordings(_ device: ConnectedDevice) async throws -> [DeviceRecording] {
        [recording]
    }

    func syncRecording(
        _ device: ConnectedDevice,
        recording: DeviceRecording,
        sinkID: String
    ) async throws -> AsyncThrowingStream<RecordingSyncEvent, Error> {
        sinkIDs.append(sinkID)
        let pair = AsyncThrowingStream<RecordingSyncEvent, Error>.makeStream()
        pair.continuation.yield(.progress(.init(completedBytes: 24_000, totalBytes: 48_000)))
        pair.continuation.yield(.completed(URL(fileURLWithPath: "/tmp/bota-recordings/recording-1.ogg")))
        pair.continuation.finish()
        return pair.stream
    }

    func transferMetadata(sinkID _: String) async -> RecordingTransferMetadata? {
        RecordingTransferMetadata(
            isE2EEncrypted: true,
            contentSHA256Hex: String(repeating: "5a", count: 32)
        )
    }

    func confirmRecording(_ device: ConnectedDevice, recordingUUID: String) async throws {
        confirmedRecordingUUIDs.append(recordingUUID)
    }

    func observeUploadOwnership(
        _ device: ConnectedDevice,
        recordingUUID: String,
        uploadID: String,
        destinationID: String
    ) async throws -> AsyncThrowingStream<UploadOwnershipEvent, Error> {
        let pair = AsyncThrowingStream<UploadOwnershipEvent, Error>.makeStream()
        pair.continuation.yield(.progress(.init(completedBytes: 32_000, totalBytes: 48_000)))
        pair.continuation.yield(.result(.bluetoothFallback(
            recordingUUID: recordingUUID,
            uploadID: uploadID,
            destinationID: destinationID
        )))
        pair.continuation.finish()
        return pair.stream
    }

    func cancelCurrentOperation() async throws {
        cancelled = true
    }

    func wasCancelled() -> Bool {
        cancelled
    }

    func observedSinkIDs() -> [String] {
        sinkIDs
    }
}
