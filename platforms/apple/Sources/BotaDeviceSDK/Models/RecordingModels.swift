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
