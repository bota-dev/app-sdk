import BotaAppleSDK
import Foundation

protocol BotaDeviceSDKAppleRecordingClient: Sendable {
    func listRecordings(_ device: ConnectedDevice) async throws -> [DeviceRecording]
    func syncRecording(
        _ device: ConnectedDevice,
        recording: DeviceRecording
    ) async throws -> AsyncThrowingStream<RecordingSyncEvent, Error>
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

    func cancelCurrentOperation() async throws {
        try await recordings.cancelCurrentOperation()
    }
}

actor BotaDeviceSDKAppleRecordings {
    private enum RecordingError: LocalizedError {
        case missingNativeFile

        var errorDescription: String? {
            "recording transfer completed without a native file"
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

    func cancelAll() async {
        try? await client.cancelCurrentOperation()
    }
}
