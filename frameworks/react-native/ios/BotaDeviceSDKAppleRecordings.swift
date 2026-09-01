import BotaAppleSDK
import Foundation

struct BotaDeviceSDKAppleRecordingFile: Equatable, Sendable {
    let localPath: String
    let isE2EEncrypted: Bool
    let contentSHA256Hex: String?
}

protocol BotaDeviceSDKAppleRecordingClient: Sendable {
    func listRecordings(_ device: ConnectedDevice) async throws -> [DeviceRecording]
    func syncRecording(
        _ device: ConnectedDevice,
        recording: DeviceRecording,
        sinkID: String
    ) async throws -> AsyncThrowingStream<RecordingSyncEvent, Error>
    func transferMetadata(sinkID: String) async -> RecordingTransferMetadata?
    func confirmRecording(_ device: ConnectedDevice, recordingUUID: String) async throws
    func observeUploadOwnership(
        _ device: ConnectedDevice,
        recordingUUID: String,
        uploadID: String,
        destinationID: String
    ) async throws -> AsyncThrowingStream<UploadOwnershipEvent, Error>
    func streamRecording(
        _ device: ConnectedDevice,
        recordingUUID: String,
        sinkID: String,
        chunkSizeBytes: Int,
        flushIntervalMilliseconds: UInt64,
        destinationProvider: @escaping StreamingChunkDestinationProvider,
        finalize: @escaping StreamingFinalizeHandler
    ) async throws -> AsyncThrowingStream<StreamingRecordingEvent, Error>
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
        recording: DeviceRecording,
        sinkID: String
    ) async throws -> AsyncThrowingStream<RecordingSyncEvent, Error> {
        try await recordings.syncRecording(
            device,
            recording: recording,
            sinkID: sinkID,
            confirmOnCompletion: false
        )
    }

    func transferMetadata(sinkID: String) async -> RecordingTransferMetadata? {
        await recordings.transferMetadata(sinkID: sinkID)
    }

    func confirmRecording(_ device: ConnectedDevice, recordingUUID: String) async throws {
        try await recordings.confirmRecording(device, recordingUUID: recordingUUID)
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

    func streamRecording(
        _ device: ConnectedDevice,
        recordingUUID: String,
        sinkID: String,
        chunkSizeBytes: Int,
        flushIntervalMilliseconds: UInt64,
        destinationProvider: @escaping StreamingChunkDestinationProvider,
        finalize: @escaping StreamingFinalizeHandler
    ) async throws -> AsyncThrowingStream<StreamingRecordingEvent, Error> {
        try await recordings.streamRecording(
            device,
            recordingUUID: recordingUUID,
            sinkID: sinkID,
            chunkSizeBytes: chunkSizeBytes,
            flushIntervalMilliseconds: flushIntervalMilliseconds,
            destinationProvider: destinationProvider,
            finalize: finalize
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
        case invalidStreamingDestination
        case requestRejected(String)

        var errorDescription: String? {
            switch self {
            case .missingNativeFile:
                "recording transfer completed without a native file"
            case .missingUploadOwnershipResult:
                "upload ownership completed without a result"
            case .invalidStreamingDestination:
                "streaming upload destination is invalid"
            case let .requestRejected(message):
                message
            }
        }
    }

    private let client: any BotaDeviceSDKAppleRecordingClient
    private var destinationRequests: [
        String: CheckedContinuation<StreamingUploadDestination, Error>
    ] = [:]
    private var finalizeRequests: [String: CheckedContinuation<Void, Error>] = [:]
    private var activeStreamingSessionID: String?

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
        sinkID: String,
        onProgress: @escaping @Sendable (RecordingTransferProgress) -> Void
    ) async throws -> BotaDeviceSDKAppleRecordingFile {
        let events = try await client.syncRecording(
            device,
            recording: recording,
            sinkID: sinkID
        )
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
        let metadata = await client.transferMetadata(sinkID: sinkID)
        return BotaDeviceSDKAppleRecordingFile(
            localPath: path,
            isE2EEncrypted: metadata?.isE2EEncrypted ?? false,
            contentSHA256Hex: metadata?.contentSHA256Hex
        )
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

    func confirmRecording(_ device: ConnectedDevice, recordingUUID: String) async throws {
        try await client.confirmRecording(device, recordingUUID: recordingUUID)
    }

    func streamRecording(
        _ device: ConnectedDevice,
        recordingUUID: String,
        sessionID: String,
        chunkSizeBytes: Int,
        flushIntervalMilliseconds: UInt64,
        onProgress: @escaping @Sendable ([String: Any]) -> Void,
        onDestinationRequest: @escaping @Sendable ([String: Any]) -> Void,
        onFinalizeRequest: @escaping @Sendable ([String: Any]) -> Void
    ) async throws -> UInt64 {
        activeStreamingSessionID = sessionID
        var bytesReceived: UInt64 = 0
        var chunksUploaded: UInt32 = 0
        onProgress(Self.progress(
            sessionID: sessionID,
            state: "streaming",
            bytesReceived: bytesReceived,
            chunksUploaded: chunksUploaded
        ))
        defer { activeStreamingSessionID = nil }
        let events = try await client.streamRecording(
            device,
            recordingUUID: recordingUUID,
            sinkID: sessionID,
            chunkSizeBytes: chunkSizeBytes,
            flushIntervalMilliseconds: flushIntervalMilliseconds,
            destinationProvider: { request in
                try await self.requestDestination(
                    sessionID: sessionID,
                    request: request,
                    onRequest: onDestinationRequest
                )
            },
            finalize: { metadata in
                try await self.requestFinalize(
                    sessionID: sessionID,
                    metadata: metadata,
                    onRequest: onFinalizeRequest
                )
            }
        )
        for try await event in events {
            switch event {
            case let .paused(completedBytes):
                bytesReceived = completedBytes
                onProgress(Self.progress(
                    sessionID: sessionID,
                    state: "paused",
                    bytesReceived: bytesReceived,
                    chunksUploaded: chunksUploaded
                ))
            case .resumed:
                onProgress(Self.progress(
                    sessionID: sessionID,
                    state: "streaming",
                    bytesReceived: bytesReceived,
                    chunksUploaded: chunksUploaded
                ))
            case let .completed(totalBytes, uploaded, _):
                bytesReceived = totalBytes
                chunksUploaded = uploaded
                onProgress(Self.progress(
                    sessionID: sessionID,
                    state: "completing",
                    bytesReceived: bytesReceived,
                    chunksUploaded: chunksUploaded
                ))
            }
        }
        return bytesReceived
    }

    func resolveStreamingDestination(
        requestID: String,
        url: String,
        method: String,
        contentType: String,
        bearerToken: String?
    ) {
        guard let continuation = destinationRequests.removeValue(forKey: requestID) else { return }
        guard let url = URL(string: url),
              let method = StreamingUploadMethod(rawValue: method)
        else {
            continuation.resume(throwing: RecordingError.invalidStreamingDestination)
            return
        }
        continuation.resume(returning: .init(
            url: url,
            method: method,
            contentType: contentType,
            bearerToken: bearerToken
        ))
    }

    func rejectStreamingDestination(requestID: String, message: String) {
        destinationRequests.removeValue(forKey: requestID)?.resume(
            throwing: RecordingError.requestRejected(message)
        )
    }

    func resolveStreamingFinalize(requestID: String) {
        finalizeRequests.removeValue(forKey: requestID)?.resume()
    }

    func rejectStreamingFinalize(requestID: String, message: String) {
        finalizeRequests.removeValue(forKey: requestID)?.resume(
            throwing: RecordingError.requestRejected(message)
        )
    }

    func abortStreaming(sessionID: String) async {
        guard activeStreamingSessionID == sessionID else { return }
        rejectPendingRequests(message: "streaming session was aborted")
        try? await client.cancelCurrentOperation()
    }

    func cancelAll() async {
        rejectPendingRequests(message: "recording operations were cancelled")
        try? await client.cancelCurrentOperation()
    }

    private func requestDestination(
        sessionID: String,
        request: StreamingChunkRequest,
        onRequest: @escaping @Sendable ([String: Any]) -> Void
    ) async throws -> StreamingUploadDestination {
        let requestID = UUID().uuidString
        return try await withCheckedThrowingContinuation { continuation in
            destinationRequests[requestID] = continuation
            onRequest([
                "requestId": requestID,
                "sessionId": sessionID,
                "sequence": request.sequence,
                "encrypted": request.isEncrypted,
            ])
        }
    }

    private func requestFinalize(
        sessionID: String,
        metadata: StreamingFinalizeMetadata,
        onRequest: @escaping @Sendable ([String: Any]) -> Void
    ) async throws {
        let requestID = UUID().uuidString
        try await withCheckedThrowingContinuation { continuation in
            finalizeRequests[requestID] = continuation
            onRequest([
                "requestId": requestID,
                "sessionId": sessionID,
                "totalChunks": metadata.totalChunks,
                "durationMs": metadata.durationMilliseconds,
                "fileSizeBytes": metadata.fileSizeBytes,
                "encrypted": metadata.isEncrypted,
            ])
        }
    }

    private func rejectPendingRequests(message: String) {
        let error = RecordingError.requestRejected(message)
        let destinations = destinationRequests.values
        let finalizations = finalizeRequests.values
        destinationRequests.removeAll()
        finalizeRequests.removeAll()
        destinations.forEach { $0.resume(throwing: error) }
        finalizations.forEach { $0.resume(throwing: error) }
    }

    private static func progress(
        sessionID: String,
        state: String,
        bytesReceived: UInt64,
        chunksUploaded: UInt32
    ) -> [String: Any] {
        [
            "sessionId": sessionID,
            "state": state,
            "bytesReceived": bytesReceived,
            "chunksUploaded": chunksUploaded,
        ]
    }
}
