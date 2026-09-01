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

    func testStreamingResolvesOneShotRequestsAndMapsProgress() async throws {
        let client = TestAppleRecordingClient(recording: DeviceRecording(
            uuid: "recording-1",
            startedAt: Date(timeIntervalSince1970: 1_788_200_000),
            durationMs: 12_000,
            fileSizeBytes: 48_000,
            codec: .known(.opus16k),
            isEncrypted: false
        ))
        let recordings = BotaDeviceSDKAppleRecordings(client: client)
        let capture = StreamingCapture()

        let total = try await recordings.streamRecording(
            ConnectedDevice(
                id: "selected",
                serialNumber: "EVFXXW67KP",
                deviceType: .botaPin,
                firmwareVersion: "1.0.11",
                isProvisioned: true,
                connectionState: .connected,
                mtu: 247
            ),
            recordingUUID: "recording-1",
            sessionID: UUID().uuidString,
            chunkSizeBytes: 64 * 1_024,
            flushIntervalMilliseconds: 1_000,
            onProgress: { value in
                let state = value["state"] as! String
                Task { await capture.progress(state) }
            },
            onDestinationRequest: { value in
                let requestID = value["requestId"] as! String
                let sequence = value["sequence"] as! UInt32
                let encrypted = value["encrypted"] as! Bool
                Task {
                    await capture.destination(sequence: sequence, encrypted: encrypted)
                    await recordings.resolveStreamingDestination(
                        requestID: requestID,
                        url: "https://example.test/chunk/1",
                        method: "PUT",
                        contentType: "audio/ogg",
                        bearerToken: nil
                    )
                }
            },
            onFinalizeRequest: { value in
                let requestID = value["requestId"] as! String
                let totalChunks = value["totalChunks"] as! UInt32
                Task {
                    await capture.finalize(totalChunks: totalChunks)
                    await recordings.resolveStreamingFinalize(
                        requestID: requestID
                    )
                }
            }
        )

        XCTAssertEqual(total, 96)
        let destinationSequence = await capture.destinationSequence
        let destinationEncrypted = await capture.destinationEncrypted
        let finalizedChunks = await capture.finalizedChunks
        let states = await capture.states
        XCTAssertEqual(destinationSequence, 1)
        XCTAssertEqual(destinationEncrypted, false)
        XCTAssertEqual(finalizedChunks, 2)
        XCTAssertEqual(states, ["streaming", "paused", "streaming", "completing"])
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

private actor StreamingCapture {
    private(set) var destinationSequence: UInt32?
    private(set) var destinationEncrypted: Bool?
    private(set) var finalizedChunks: UInt32?
    private var progressValues: [String] = []

    var states: [String] { progressValues }

    func progress(_ state: String) { progressValues.append(state) }
    func destination(sequence: UInt32, encrypted: Bool) {
        destinationSequence = sequence
        destinationEncrypted = encrypted
    }
    func finalize(totalChunks: UInt32) {
        finalizedChunks = totalChunks
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

    func streamRecording(
        _ device: ConnectedDevice,
        recordingUUID: String,
        sinkID: String,
        chunkSizeBytes: Int,
        flushIntervalMilliseconds: UInt64,
        destinationProvider: @escaping StreamingChunkDestinationProvider,
        finalize: @escaping StreamingFinalizeHandler
    ) async throws -> AsyncThrowingStream<StreamingRecordingEvent, Error> {
        sinkIDs.append(sinkID)
        let pair = AsyncThrowingStream<StreamingRecordingEvent, Error>.makeStream()
        Task {
            do {
                _ = try await destinationProvider(.init(sequence: 1, isEncrypted: false))
                try await finalize(.init(
                    totalChunks: 2,
                    durationMilliseconds: 500,
                    fileSizeBytes: 96,
                    isEncrypted: false
                ))
                pair.continuation.yield(.paused(completedBytes: 32))
                pair.continuation.yield(.resumed)
                pair.continuation.yield(.completed(
                    totalBytes: 96,
                    uploadedChunks: 2,
                    isEncrypted: false
                ))
                pair.continuation.finish()
            } catch {
                pair.continuation.finish(throwing: error)
            }
        }
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
