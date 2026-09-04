import Foundation

enum RecordingUploadProfileValue: UInt64, Equatable, Sendable {
    case legacyPlainV1 = 1
    case legacyP10Relay = 2
    case encryptedUploadV2 = 3
}

enum UploadSecurityPolicyValue: UInt64, Equatable, Sendable {
    case legacyAllowed = 1
    case v2Preferred = 2
    case v2Required = 3
}

struct EncryptedUploadV2CapabilitiesValue: Equatable, Sendable {
    let flags: UInt32
    let maximumSignedBlobBytes: UInt16
    let maximumManifestBytes: UInt16
    let maximumDataPayloadBytes: UInt16
    let maximumWindowPackets: UInt16
    let durableCheckpointIntervalBlocks: UInt32
    let maximumMissingSequences: UInt16
}

struct EncryptedUploadV2SignedBlobResultValue: Equatable, Sendable {
    let kind: UInt8
    let writeID: UInt32
    let result: UInt16
}

struct EncryptedUploadV2StartRequestValue: Equatable, Sendable {
    let transportSessionID: UInt64
    let uploadSessionID: UUID
    let recordingUUID: String
    let recordingGeneration: UInt32
    let authorizationSHA256: Data
    let expectedCiphertextLength: UInt64
    let expectedCiphertextSHA256: Data
    let expectedCheckpointIntervalBlocks: UInt32
    let checkpointRevision: UInt32
    let nextCiphertextOffset: UInt64
    let prefixSHA256: Data
    let windowPackets: UInt16
    let dataPayloadBytes: UInt16
}

struct EncryptedUploadV2ResumeRequestValue: Equatable, Sendable {
    let transportSessionID: UInt64
    let uploadSessionID: UUID
    let recordingUUID: String
    let recordingGeneration: UInt32
    let checkpointRevision: UInt32
    let nextCiphertextOffset: UInt64
    let prefixSHA256: Data
    let windowPackets: UInt16
    let dataPayloadBytes: UInt16
}

struct EncryptedUploadV2StartAcknowledgementValue: Equatable, Sendable {
    let transportSessionID: UInt64
    let uploadSessionID: UUID
    let recordingUUID: String
    let recordingGeneration: UInt32
    let ciphertextLength: UInt64
    let ciphertextSHA256: Data
    let windowPackets: UInt16
    let dataPayloadBytes: UInt16
    let checkpointIntervalBlocks: UInt32
    let checkpointRevision: UInt32
    let nextCiphertextOffset: UInt64
    let prefixSHA256: Data
}

struct EncryptedUploadV2ResumeValue: Equatable, Sendable {
    let transportSessionID: UInt64
    let uploadSessionID: UUID
    let recordingUUID: String
    let recordingGeneration: UInt32
    let checkpointRevision: UInt32
    let nextCiphertextOffset: UInt64
    let prefixSHA256: Data
    let windowPackets: UInt16
    let dataPayloadBytes: UInt16
}

struct EncryptedUploadV2ResumeRejectionValue: Equatable, Sendable {
    let transportSessionID: UInt64
    let reason: UInt16
    let checkpointRevision: UInt32
    let nextCiphertextOffset: UInt64
    let prefixSHA256: Data
}

struct EncryptedUploadV2TransferErrorValue: Equatable, Sendable {
    let transportSessionID: UInt64
    let result: UInt16
    let failedMessageType: UInt8
    let checkpointRevision: UInt32
}

struct EncryptedUploadV2TransferControlRejection: Error, Equatable, Sendable {
    let sdkError: BotaSDKError
    let deviceError: EncryptedUploadV2TransferErrorValue
}

enum EncryptedUploadV2TransferControlValue: Equatable, Sendable {
    case startAccepted(EncryptedUploadV2StartAcknowledgementValue)
    case resumeAccepted(EncryptedUploadV2ResumeValue)
    case resumeRejected(EncryptedUploadV2ResumeRejectionValue)
    case error(EncryptedUploadV2TransferErrorValue)
}

enum EncryptedUploadV2ResumeDecision: Equatable, Sendable {
    case accepted(EncryptedUploadV2ResumeValue)
    case rejected(EncryptedUploadV2ResumeRejectionValue)
}

struct EncryptedUploadV2CommandRequest: Equatable, Sendable {
    let serialNumber: String
    let recordingUUID: String
    let recordingGeneration: UInt32
    let storageFormat: UInt8
    let uploadSessionID: UUID
    let ownerRevision: UInt32
    let transportSessionID: UInt64
    let materialID: String
    let sinkID: String
    let profile: RecordingUploadProfileValue
    let securityPolicy: UploadSecurityPolicyValue
    let capabilities: EncryptedUploadV2CapabilitiesValue
    let windowPackets: UInt16
    let dataPayloadBytes: UInt16
    let ciphertextLength: UInt64
    let ciphertextSHA256: Data
}

struct EncryptedUploadV2ContractValue: Equatable {
    let kind: UInt8
    let messageType: UInt8?
    let flags: UInt32?
    let transportSessionID: UInt64?
    let recordingUUID: String?
    let recordingGeneration: UInt32?
    let sequence: UInt32?
    let offset: UInt64?
    let length: UInt64?
    let result: UInt16?
    let authorizationSHA256: Data?
    let ciphertextSHA256: Data?
    let prefixSHA256: Data?
    let manifestSHA256: Data?
    let receiptSHA256: Data?
}
