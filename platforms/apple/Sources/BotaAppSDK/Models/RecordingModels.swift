import Foundation

public enum AudioCodec: Equatable, Sendable {
    case pcm16k
    case pcm8k
    case opus16k
    case opus8k
}

public struct DeviceRecording: Equatable, Sendable {
    public var uuid: String
    public var startedAt: Date
    public var durationMs: UInt64
    public var fileSizeBytes: UInt64
    public var codec: WireValue<AudioCodec>
    public var isEncrypted: Bool

    public init(
        uuid: String,
        startedAt: Date,
        durationMs: UInt64,
        fileSizeBytes: UInt64,
        codec: WireValue<AudioCodec>,
        isEncrypted: Bool
    ) {
        self.uuid = uuid
        self.startedAt = startedAt
        self.durationMs = durationMs
        self.fileSizeBytes = fileSizeBytes
        self.codec = codec
        self.isEncrypted = isEncrypted
    }
}

public enum RecordingInitiator: Equatable, Sendable {
    case local
    case remote
}

public struct RecordingState: Equatable, Sendable {
    public var active: Bool
    public var recordingID: String?
    public var initiatedBy: RecordingInitiator

    public init(
        active: Bool,
        recordingID: String? = nil,
        initiatedBy: RecordingInitiator = .local
    ) {
        self.active = active
        self.recordingID = recordingID
        self.initiatedBy = initiatedBy
    }
}

public enum RecordingControlError: String, Equatable, Sendable {
    case alreadyRecording = "already_recording"
    case notRecording = "not_recording"
    case invalidGrant = "invalid_grant"
    case grantExpired = "grant_expired"
    case invalidState = "invalid_state"
    case invalidResponse = "invalid_response"
    case unknownError = "unknown_error"
}

public struct RecordingControlResult: Equatable, Sendable {
    public var success: Bool
    public var error: RecordingControlError?

    public init(success: Bool, error: RecordingControlError? = nil) {
        self.success = success
        self.error = error
    }
}

public enum TransferPacketType: Equatable, Sendable {
    case data
    case eof
    case paused
    case sha256
    case e2eStart
    case encryptedData
    case encryptedEof
    case error
}

public struct TransferPacket: Equatable, Sendable {
    public var type: TransferPacketType
    public var sequenceNumber: UInt16
    public var data: Data?
    public var checksum: UInt32?
    public var bytesSent: UInt32?
    public var errorCode: UInt8?
    public var e2eEphemeralPublicKey: Data?
    public var e2eSalt: Data?
    public var e2eChunk: Data?
    public var sha256: Data?

    public init(
        type: TransferPacketType,
        sequenceNumber: UInt16 = 0,
        data: Data? = nil,
        checksum: UInt32? = nil,
        bytesSent: UInt32? = nil,
        errorCode: UInt8? = nil,
        e2eEphemeralPublicKey: Data? = nil,
        e2eSalt: Data? = nil,
        e2eChunk: Data? = nil,
        sha256: Data? = nil
    ) {
        self.type = type
        self.sequenceNumber = sequenceNumber
        self.data = data
        self.checksum = checksum
        self.bytesSent = bytesSent
        self.errorCode = errorCode
        self.e2eEphemeralPublicKey = e2eEphemeralPublicKey
        self.e2eSalt = e2eSalt
        self.e2eChunk = e2eChunk
        self.sha256 = sha256
    }
}

public struct TriggerDeviceUploadResponse: Equatable, Sendable {
    public let accepted: Bool
    public let errorCode: UInt8?

    public init(accepted: Bool, errorCode: UInt8? = nil) {
        self.accepted = accepted
        self.errorCode = errorCode
    }
}

public enum AckType: Equatable, Sendable {
    case ack
    case nack
    case abort
}

public enum TransferCommand: Equatable, Sendable {
    case list
    case start(recordingUUID: String)
    case triggerDeviceUpload
    case confirm(recordingUUID: String)
}

public enum StreamingUploadMethod: String, Equatable, Sendable {
    case put = "PUT"
    case post = "POST"
}

public struct StreamingChunkRequest: Equatable, Sendable {
    public let sequence: UInt32
    public let isEncrypted: Bool

    public init(sequence: UInt32, isEncrypted: Bool) {
        self.sequence = sequence
        self.isEncrypted = isEncrypted
    }
}

public struct StreamingUploadDestination: Equatable, Sendable {
    public let url: URL
    public let method: StreamingUploadMethod
    public let contentType: String
    public let bearerToken: String?

    public init(
        url: URL,
        method: StreamingUploadMethod,
        contentType: String,
        bearerToken: String? = nil
    ) {
        self.url = url
        self.method = method
        self.contentType = contentType
        self.bearerToken = bearerToken
    }
}

public struct StreamingFinalizeMetadata: Equatable, Sendable {
    public let totalChunks: UInt32
    public let durationMilliseconds: UInt64
    public let fileSizeBytes: UInt64
    public let isEncrypted: Bool

    public init(
        totalChunks: UInt32,
        durationMilliseconds: UInt64,
        fileSizeBytes: UInt64,
        isEncrypted: Bool
    ) {
        self.totalChunks = totalChunks
        self.durationMilliseconds = durationMilliseconds
        self.fileSizeBytes = fileSizeBytes
        self.isEncrypted = isEncrypted
    }
}

public typealias StreamingChunkDestinationProvider = @Sendable (
    StreamingChunkRequest
) async throws -> StreamingUploadDestination
public typealias StreamingFinalizeHandler = @Sendable (
    StreamingFinalizeMetadata
) async throws -> Void

public enum StreamingRecordingEvent: Equatable, Sendable {
    case paused(completedBytes: UInt64)
    case resumed
    case completed(totalBytes: UInt64, uploadedChunks: UInt32, isEncrypted: Bool)
}
