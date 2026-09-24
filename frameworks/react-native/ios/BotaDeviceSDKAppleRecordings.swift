import BotaAppSDK
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
    func syncEncryptedRecordingV2(
        _ device: ConnectedDevice,
        recording: EncryptedUploadV2Recording,
        provider: @escaping EncryptedUploadV2ProfileProvider
    ) async throws
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

    func syncEncryptedRecordingV2(
        _ device: ConnectedDevice,
        recording: EncryptedUploadV2Recording,
        provider: @escaping EncryptedUploadV2ProfileProvider
    ) async throws {
        try await recordings.syncEncryptedRecordingV2(
            device,
            recording: recording,
            provider: provider
        )
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
        case invalidEncryptedUploadV2Selection
        case encryptedUploadV2MaterialRejected
        case missingEncryptedUploadV2Request
        case invalidStreamingDestination
        case requestRejected(String)

        var errorDescription: String? {
            switch self {
            case .missingNativeFile:
                "recording transfer completed without a native file"
            case .missingUploadOwnershipResult:
                "upload ownership completed without a result"
            case .invalidEncryptedUploadV2Selection:
                "encrypted upload v2 requires an explicit matching profile"
            case .encryptedUploadV2MaterialRejected:
                "encrypted upload v2 material was rejected"
            case .missingEncryptedUploadV2Request:
                "encrypted upload v2 profile request is no longer pending"
            case .invalidStreamingDestination:
                "streaming upload destination is invalid"
            case let .requestRejected(message):
                message
            }
        }
    }

    private let client: any BotaDeviceSDKAppleRecordingClient
    private struct EncryptedUploadV2Request {
        let recording: EncryptedUploadV2Recording
        let continuation: CheckedContinuation<EncryptedUploadV2Material, Error>
    }
    private var encryptedUploadV2Requests: [String: EncryptedUploadV2Request] = [:]
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

    func syncEncryptedRecordingV2(
        _ device: ConnectedDevice,
        recording: EncryptedUploadV2Recording,
        operationID: String,
        onProfileRequest: @escaping @Sendable ([String: Any]) -> Void,
        onProgress: @escaping @Sendable ([String: Any]) -> Void
    ) async throws {
        do {
            try await client.syncEncryptedRecordingV2(
                device,
                recording: recording
            ) { context in
                let completedBytes = String(context.checkpoint?.nextCiphertextOffset ?? 0)
                let checkpointRevision = context.checkpoint?.revision
                onProgress(Self.encryptedUploadV2Progress(
                    operationID: operationID,
                    recordingUUID: recording.uuid,
                    phase: "profile_requested",
                    completedBytes: completedBytes,
                    totalBytes: String(recording.ciphertextLength),
                    checkpointRevision: checkpointRevision
                ))
                let material = try await self.requestEncryptedUploadV2Profile(
                    operationID: operationID,
                    context: context,
                    onRequest: onProfileRequest
                )
                onProgress(Self.encryptedUploadV2Progress(
                    operationID: operationID,
                    recordingUUID: recording.uuid,
                    phase: "transferring",
                    completedBytes: completedBytes,
                    totalBytes: String(recording.ciphertextLength),
                    checkpointRevision: checkpointRevision
                ))
                return material
            }
            onProgress(Self.encryptedUploadV2Progress(
                operationID: operationID,
                recordingUUID: recording.uuid,
                phase: "completed",
                completedBytes: String(recording.ciphertextLength),
                totalBytes: String(recording.ciphertextLength)
            ))
        } catch {
            let failure = Self.encryptedUploadV2Failure(error)
            onProgress(Self.encryptedUploadV2Progress(
                operationID: operationID,
                recordingUUID: recording.uuid,
                phase: "failed",
                completedBytes: "0",
                totalBytes: String(recording.ciphertextLength),
                errorCode: failure.code,
                retryable: failure.retryable,
                protocolStatus: failure.protocolStatus
            ))
            throw error
        }
    }

    func resolveEncryptedUploadV2Profile(
        requestID: String,
        profile: String,
        uploadSessionID: String,
        ownerRevision: UInt32,
        securityPolicy: String,
        materialRegistrationID: String
    ) throws {
        guard let request = encryptedUploadV2Requests.removeValue(forKey: requestID) else {
            throw RecordingError.missingEncryptedUploadV2Request
        }
        do {
            guard profile == "encrypted_upload_v2",
                  let sessionID = UUID(uuidString: uploadSessionID)
            else {
                throw RecordingError.invalidEncryptedUploadV2Selection
            }
            let material = try BotaDeviceSDKEncryptedUploadV2Materials.consume(
                materialRegistrationID,
                recording: request.recording,
                uploadSessionID: sessionID,
                ownerRevision: ownerRevision,
                securityPolicy: securityPolicy
            )
            request.continuation.resume(returning: material)
        } catch {
            request.continuation.resume(throwing: error)
            throw error
        }
    }

    func rejectEncryptedUploadV2Profile(requestID: String, errorCode: String) throws {
        guard let request = encryptedUploadV2Requests.removeValue(forKey: requestID) else {
            throw RecordingError.missingEncryptedUploadV2Request
        }
        guard errorCode == "application_material_rejected" else {
            request.continuation.resume(throwing: RecordingError.invalidEncryptedUploadV2Selection)
            throw RecordingError.invalidEncryptedUploadV2Selection
        }
        request.continuation.resume(throwing: RecordingError.encryptedUploadV2MaterialRejected)
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

    private func requestEncryptedUploadV2Profile(
        operationID: String,
        context: EncryptedUploadV2ProviderContext,
        onRequest: @escaping @Sendable ([String: Any]) -> Void
    ) async throws -> EncryptedUploadV2Material {
        let requestID = UUID().uuidString.lowercased()
        return try await withCheckedThrowingContinuation { continuation in
            encryptedUploadV2Requests[requestID] = .init(
                recording: context.recording,
                continuation: continuation
            )
            var request: [String: Any] = [
                "requestId": requestID,
                "operationId": operationID,
                "recording": Self.encryptedUploadV2Recording(context.recording),
                "capability": Self.encryptedUploadV2Capability(context.capability),
            ]
            if let checkpoint = context.checkpoint {
                request["checkpoint"] = Self.encryptedUploadV2Checkpoint(checkpoint)
            }
            onRequest(request)
        }
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
        let encryptedUploadV2 = encryptedUploadV2Requests.values
        let destinations = destinationRequests.values
        let finalizations = finalizeRequests.values
        destinationRequests.removeAll()
        finalizeRequests.removeAll()
        encryptedUploadV2Requests.removeAll()
        encryptedUploadV2.forEach { $0.continuation.resume(throwing: error) }
        destinations.forEach { $0.resume(throwing: error) }
        finalizations.forEach { $0.resume(throwing: error) }
    }

    private static func encryptedUploadV2Recording(
        _ recording: EncryptedUploadV2Recording
    ) -> [String: Any] {
        [
            "uuid": recording.uuid,
            "generation": recording.generation,
            "ciphertextLength": String(recording.ciphertextLength),
            "ciphertextSha256": recording.ciphertextSHA256.hexString,
        ]
    }

    private static func encryptedUploadV2Capability(
        _ snapshot: EncryptedUploadV2CapabilitySnapshot
    ) -> [String: Any] {
        let values = snapshot.capabilities
        return [
            "encodingVersion": Int(snapshot.rawValue.first ?? 0),
            "transferProfileVersion": Int(snapshot.rawValue.dropFirst().first ?? 0),
            "rawValueHex": snapshot.rawValue.hexString,
            "sha256Hex": snapshot.sha256.hexString,
            "flags": values.flags,
            "maximumSignedBlobBytes": values.maximumSignedBlobBytes,
            "maximumManifestBytes": values.maximumManifestBytes,
            "maximumDataPayloadBytes": values.maximumDataPayloadBytes,
            "maximumWindowPackets": values.maximumWindowPackets,
            "durableCheckpointIntervalBlocks": values.durableCheckpointIntervalBlocks,
            "maximumMissingSequences": values.maximumMissingSequences,
        ]
    }

    private static func encryptedUploadV2Checkpoint(
        _ checkpoint: EncryptedUploadV2Checkpoint
    ) -> [String: Any] {
        var value: [String: Any] = [
            "version": 1,
            "uploadSessionId": checkpoint.uploadSessionID.uuidString.lowercased(),
            "ownerRevision": checkpoint.ownerRevision,
            "revision": checkpoint.revision,
            "nextCiphertextOffset": String(checkpoint.nextCiphertextOffset),
            "prefixSha256": checkpoint.prefixSHA256.hexString,
            "transportSessionId": String(checkpoint.transportSessionID),
            "sinkRegistrationId": checkpoint.sinkID,
            "windowPackets": checkpoint.windowPackets,
            "dataPayloadBytes": checkpoint.dataPayloadBytes,
        ]
        if let sequence = checkpoint.highestContiguousSequence {
            value["highestContiguousSequence"] = sequence
        }
        return value
    }

    private static func encryptedUploadV2Progress(
        operationID: String,
        recordingUUID: String,
        phase: String,
        completedBytes: String,
        totalBytes: String,
        checkpointRevision: UInt32? = nil,
        errorCode: String? = nil,
        retryable: Bool? = nil,
        protocolStatus: UInt16? = nil
    ) -> [String: Any] {
        var value: [String: Any] = [
            "operationId": operationID,
            "recordingUuid": recordingUUID,
            "phase": phase,
            "completedBytes": completedBytes,
            "totalBytes": totalBytes,
        ]
        if let checkpointRevision { value["checkpointRevision"] = checkpointRevision }
        if let errorCode { value["errorCode"] = errorCode }
        if let retryable { value["retryable"] = retryable }
        if let protocolStatus { value["protocolStatus"] = protocolStatus }
        return value
    }

    private static func encryptedUploadV2Failure(
        _ error: Error
    ) -> (code: String, retryable: Bool, protocolStatus: UInt16?) {
        guard let sdkError = error as? BotaSDKError else {
            return (
                error is CancellationError ? "cancelled" : "application_material_rejected",
                false,
                nil
            )
        }
        return (sdkError.code.stableName, sdkError.retryable, sdkError.protocolStatus)
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

private extension Data {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}

private extension BotaSDKErrorCode {
    var stableName: String {
        switch self {
        case .invalidInput: "invalid_input"
        case .truncatedPacket: "truncated_packet"
        case .unknownPacket: "unknown_packet"
        case .payloadTooLarge: "payload_too_large"
        case .unsupportedCapability: "unsupported_capability"
        case .unsupportedOperation: "unsupported_operation"
        case .featureUnavailable: "feature_unavailable"
        case .operationInProgress: "operation_in_progress"
        case .unexpectedEvent: "unexpected_event"
        case .deviceNotFound: "device_not_found"
        case .identityMismatch: "identity_mismatch"
        case .connectionFailed: "connection_failed"
        case .persistenceFailed: "persistence_failed"
        case .notConnected: "not_connected"
        case .timeout: "timeout"
        case .cancelled: "cancelled"
        case .protocolRejected: "protocol_rejected"
        case .integrityFailed: "integrity_failed"
        case .uploadOwnershipUnknown: "upload_ownership_unknown"
        case .downloadFailed: "download_failed"
        case .internal: "internal"
        case .unknown: "unknown"
        }
    }
}
