import BotaAppleSDK
import Foundation

protocol BotaDeviceSDKAppleRecordingClient: Sendable {
    func listRecordings(_ device: ConnectedDevice) async throws -> [DeviceRecording]
    func syncRecording(
        _ device: ConnectedDevice,
        recording: DeviceRecording
    ) async throws -> AsyncThrowingStream<RecordingSyncEvent, Error>
    func observeUploadOwnership(
        _ device: ConnectedDevice,
        recordingUUID: String,
        uploadID: String,
        destinationID: String
    ) async throws -> AsyncThrowingStream<UploadOwnershipEvent, Error>
    func cancelCurrentOperation() async throws
}

struct BotaDeviceSDKSharedAppleRecordingClient: BotaDeviceSDKAppleRecordingClient {
    private let recordings: RecordingManager

    init(client: BotaDeviceClient = .shared) {
        recordings = client.recordings
    }

    func listRecordings(_ device: ConnectedDevice) async throws -> [DeviceRecording] {
        try await recordings.listRecordings(device)
    }

    func syncRecording(
        _ device: ConnectedDevice,
        recording: DeviceRecording
    ) async throws -> AsyncThrowingStream<RecordingSyncEvent, Error> {
        try await recordings.syncRecording(device, recording: recording)
    }

    func observeUploadOwnership(
        _ device: ConnectedDevice,
        recordingUUID: String,
        uploadID: String,
        destinationID: String
    ) async throws -> AsyncThrowingStream<UploadOwnershipEvent, Error> {
        try await recordings.observeUploadOwnership(
            device,
            recordingUUID: recordingUUID,
            uploadID: uploadID,
            destinationID: destinationID
        )
    }

    func cancelCurrentOperation() async throws {
        try await recordings.cancelCurrentOperation()
    }
}

actor BotaDeviceSDKAppleRecordings {
    private enum RecordingError: LocalizedError {
        case missingNativeFile
        case missingUploadOwnershipResult

        var errorDescription: String? {
            switch self {
            case .missingNativeFile:
                "recording transfer completed without a native file"
            case .missingUploadOwnershipResult:
                "upload ownership completed without a result"
            }
        }
    }

    private let client: any BotaDeviceSDKAppleRecordingClient

    init(
        client: any BotaDeviceSDKAppleRecordingClient =
            BotaDeviceSDKSharedAppleRecordingClient()
    ) {
        self.client = client
    }

    func listRecordings(_ device: ConnectedDevice) async throws -> [DeviceRecording] {
        try await client.listRecordings(device)
    }

    func syncRecording(
        _ device: ConnectedDevice,
        recording: DeviceRecording,
        onProgress: @escaping @Sendable (RecordingTransferProgress) -> Void
    ) async throws -> String {
        let events = try await client.syncRecording(device, recording: recording)
        var path: String?
        for try await event in events {
            switch event {
            case let .progress(progress):
                onProgress(progress)
            case let .completed(url):
                path = url.path
            }
        }
        guard let path else { throw RecordingError.missingNativeFile }
        return path
    }

    func observeUploadOwnership(
        _ device: ConnectedDevice,
        recordingUUID: String,
        uploadID: String,
        destinationID: String,
        onProgress: @escaping @Sendable (RecordingTransferProgress) -> Void
    ) async throws -> UploadOwnershipResult {
        let events = try await client.observeUploadOwnership(
            device,
            recordingUUID: recordingUUID,
            uploadID: uploadID,
            destinationID: destinationID
        )
        var result: UploadOwnershipResult?
        for try await event in events {
            switch event {
            case let .progress(progress):
                onProgress(progress)
            case let .result(value):
                result = value
            }
        }
        guard let result else { throw RecordingError.missingUploadOwnershipResult }
        return result
    }

    func cancelAll() async {
        try? await client.cancelCurrentOperation()
    }
}
