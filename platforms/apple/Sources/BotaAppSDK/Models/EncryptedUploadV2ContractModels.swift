import Foundation

public struct EncryptedUploadV2Capabilities: Equatable, Sendable {
    public let flags: UInt32
    public let maximumSignedBlobBytes: UInt16
    public let maximumManifestBytes: UInt16
    public let maximumDataPayloadBytes: UInt16
    public let maximumWindowPackets: UInt16
    public let durableCheckpointIntervalBlocks: UInt32
    public let maximumMissingSequences: UInt16

    public init(
        flags: UInt32,
        maximumSignedBlobBytes: UInt16,
        maximumManifestBytes: UInt16,
        maximumDataPayloadBytes: UInt16,
        maximumWindowPackets: UInt16,
        durableCheckpointIntervalBlocks: UInt32,
        maximumMissingSequences: UInt16
    ) {
        self.flags = flags
        self.maximumSignedBlobBytes = maximumSignedBlobBytes
        self.maximumManifestBytes = maximumManifestBytes
        self.maximumDataPayloadBytes = maximumDataPayloadBytes
        self.maximumWindowPackets = maximumWindowPackets
        self.durableCheckpointIntervalBlocks = durableCheckpointIntervalBlocks
        self.maximumMissingSequences = maximumMissingSequences
    }

    var value: EncryptedUploadV2CapabilitiesValue {
        .init(
            flags: flags,
            maximumSignedBlobBytes: maximumSignedBlobBytes,
            maximumManifestBytes: maximumManifestBytes,
            maximumDataPayloadBytes: maximumDataPayloadBytes,
            maximumWindowPackets: maximumWindowPackets,
            durableCheckpointIntervalBlocks: durableCheckpointIntervalBlocks,
            maximumMissingSequences: maximumMissingSequences
        )
    }

    init(value: EncryptedUploadV2CapabilitiesValue) {
        self.init(
            flags: value.flags,
            maximumSignedBlobBytes: value.maximumSignedBlobBytes,
            maximumManifestBytes: value.maximumManifestBytes,
            maximumDataPayloadBytes: value.maximumDataPayloadBytes,
            maximumWindowPackets: value.maximumWindowPackets,
            durableCheckpointIntervalBlocks: value.durableCheckpointIntervalBlocks,
            maximumMissingSequences: value.maximumMissingSequences
        )
    }
}

public struct EncryptedUploadV2CapabilitySnapshot: Equatable, Sendable {
    public let rawValue: Data
    public let sha256: Data
    public let capabilities: EncryptedUploadV2Capabilities

    public init(rawValue: Data, sha256: Data, capabilities: EncryptedUploadV2Capabilities) {
        self.rawValue = rawValue
        self.sha256 = sha256
        self.capabilities = capabilities
    }
}

public struct EncryptedUploadV2Recording: Equatable, Sendable {
    public let uuid: String
    public let generation: UInt32
    public let ciphertextLength: UInt64
    public let ciphertextSHA256: Data
    public let startedAtMs: UInt64
    public let durationMs: UInt64
    public let plaintextLength: UInt64
    public let storageFormat: UInt8

    public init(
        uuid: String, generation: UInt32, ciphertextLength: UInt64, ciphertextSHA256: Data,
        startedAtMs: UInt64 = 0, durationMs: UInt64 = 0,
        plaintextLength: UInt64 = 0, storageFormat: UInt8 = 3
    ) {
        self.uuid = uuid
        self.generation = generation
        self.ciphertextLength = ciphertextLength
        self.ciphertextSHA256 = ciphertextSHA256
        self.startedAtMs = startedAtMs
        self.durationMs = durationMs
        self.plaintextLength = plaintextLength
        self.storageFormat = storageFormat
    }
}

public enum PendingRecording: Equatable, Sendable {
    case legacy(DeviceRecording)
    case encryptedV2(EncryptedUploadV2Recording)
}

public struct EncryptedUploadV2ContextExchange: Sendable {
    public let challenge: Data
    public let exchangeProof: @Sendable (Data) async throws -> Data

    public init(challenge: Data, exchangeProof: @escaping @Sendable (Data) async throws -> Data) {
        self.challenge = challenge
        self.exchangeProof = exchangeProof
    }
}

public typealias EncryptedUploadV2ContextProvider = @Sendable (Data) async throws -> EncryptedUploadV2ContextExchange

public struct EncryptedUploadV2Checkpoint: Equatable, Sendable {
    public let uploadSessionID: UUID
    public let ownerRevision: UInt32
    public let revision: UInt32
    public let nextCiphertextOffset: UInt64
    public let prefixSHA256: Data
    public let highestContiguousSequence: UInt32?
    public let transportSessionID: UInt64
    public let sinkID: String
    public let windowPackets: UInt16
    public let dataPayloadBytes: UInt16
    public let ciphertextLength: UInt64?
    public let ciphertextSHA256: Data?

    public init(
        uploadSessionID: UUID,
        ownerRevision: UInt32,
        revision: UInt32,
        nextCiphertextOffset: UInt64,
        prefixSHA256: Data,
        highestContiguousSequence: UInt32?,
        transportSessionID: UInt64,
        sinkID: String,
        windowPackets: UInt16,
        dataPayloadBytes: UInt16,
        ciphertextLength: UInt64? = nil,
        ciphertextSHA256: Data? = nil
    ) {
        self.uploadSessionID = uploadSessionID
        self.ownerRevision = ownerRevision
        self.revision = revision
        self.nextCiphertextOffset = nextCiphertextOffset
        self.prefixSHA256 = prefixSHA256
        self.highestContiguousSequence = highestContiguousSequence
        self.transportSessionID = transportSessionID
        self.sinkID = sinkID
        self.windowPackets = windowPackets
        self.dataPayloadBytes = dataPayloadBytes
        self.ciphertextLength = ciphertextLength
        self.ciphertextSHA256 = ciphertextSHA256
    }
}

public struct EncryptedUploadV2ProviderContext: Equatable, Sendable {
    public let recording: EncryptedUploadV2Recording
    public let capability: EncryptedUploadV2CapabilitySnapshot
    public let checkpoint: EncryptedUploadV2Checkpoint?
    public let readAuthNonce: @Sendable () async throws -> Data

    public init(
        recording: EncryptedUploadV2Recording,
        capability: EncryptedUploadV2CapabilitySnapshot,
        checkpoint: EncryptedUploadV2Checkpoint?,
        readAuthNonce: @escaping @Sendable () async throws -> Data = {
            throw BotaSDKError(code: .unsupportedCapability, operation: .transferRecording,
                               retryable: false, detail: "operation-scoped auth nonce is unavailable")
        }
    ) {
        self.recording = recording
        self.capability = capability
        self.checkpoint = checkpoint
        self.readAuthNonce = readAuthNonce
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.recording == rhs.recording && lhs.capability == rhs.capability && lhs.checkpoint == rhs.checkpoint
    }
}

public enum EncryptedUploadV2SecurityPolicy: Sendable {
    case legacyAllowed
    case v2Preferred
    case v2Required

    var value: UploadSecurityPolicyValue {
        switch self {
        case .legacyAllowed: .legacyAllowed
        case .v2Preferred: .v2Preferred
        case .v2Required: .v2Required
        }
    }
}

public struct EncryptedUploadV2Material: @unchecked Sendable {
    public typealias StagingRequest = @Sendable (EncryptedUploadV2TransferEvidence) async throws -> URLRequest
    public typealias ManifestSubmitter = @Sendable (Data, EncryptedUploadV2TransferEvidence) async throws -> Void
    public typealias Finalizer = @Sendable (EncryptedUploadV2TransferEvidence) async throws -> Void
    public typealias ReceiptProvider = @Sendable (EncryptedUploadV2TransferEvidence) async throws -> Data
    public typealias CancellationHandler = @Sendable () async throws -> Void
    public typealias CiphertextUploadDecision = @Sendable (EncryptedUploadV2TransferEvidence) async throws -> Bool

    public let materialID: String
    public let recordingID: String
    public let uploadSessionID: UUID
    public let ownerRevision: UInt32
    public let policy: EncryptedUploadV2SecurityPolicy
    public let authorization: Data
    public let uploadContext: EncryptedUploadV2ContextProvider?
    public let shouldUploadCiphertext: CiphertextUploadDecision
    let stagingRequest: StagingRequest
    let submitManifest: ManifestSubmitter
    let finalize: Finalizer
    let completionReceipt: ReceiptProvider
    private let cancellationHandler: CancellationHandler
    private let cancellation = EncryptedUploadV2MaterialCancellation()

    public init(
        materialID: String,
        recordingID: String,
        uploadSessionID: UUID,
        ownerRevision: UInt32,
        policy: EncryptedUploadV2SecurityPolicy,
        authorization: Data,
        stagingRequest: @escaping StagingRequest,
        submitManifest: @escaping ManifestSubmitter,
        finalize: @escaping Finalizer,
        completionReceipt: @escaping ReceiptProvider,
        cancel: @escaping CancellationHandler = {},
        uploadContext: EncryptedUploadV2ContextProvider? = nil,
        shouldUploadCiphertext: @escaping CiphertextUploadDecision = { _ in true }
    ) {
        self.materialID = materialID
        self.recordingID = recordingID
        self.uploadSessionID = uploadSessionID
        self.ownerRevision = ownerRevision
        self.policy = policy
        self.authorization = authorization
        self.stagingRequest = stagingRequest
        self.submitManifest = submitManifest
        self.finalize = finalize
        self.completionReceipt = completionReceipt
        cancellationHandler = cancel
        self.uploadContext = uploadContext
        self.shouldUploadCiphertext = shouldUploadCiphertext
    }

    var provider: EncryptedUploadV2MaterialProvider {
        .init(
            authorization: authorization,
            stagingRequest: stagingRequest,
            submitManifest: { try await submitManifest($0.manifest, $0.evidence) },
            finalize: finalize,
            completionReceipt: completionReceipt,
            cancel: { try await cancellation.run(cancellationHandler) },
            uploadContext: uploadContext,
            shouldUploadCiphertext: shouldUploadCiphertext
        )
    }

    public func cancelPreparation() async {
        try? await cancellation.run(cancellationHandler)
    }
}

private final class EncryptedUploadV2MaterialCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var didRun = false

    func run(_ handler: @escaping EncryptedUploadV2Material.CancellationHandler) async throws {
        let shouldRun = lock.withLock { () -> Bool in
            guard !didRun else { return false }
            didRun = true
            return true
        }
        if shouldRun { try await handler() }
    }
}

public typealias EncryptedUploadV2ProfileProvider = @Sendable (
    EncryptedUploadV2ProviderContext
) async throws -> EncryptedUploadV2Material

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

struct EncryptedUploadV2DataValue: Equatable, Sendable {
    let transportSessionID: UInt64
    let sequence: UInt32
    let ciphertextOffset: UInt64
    let bytes: Data
}

struct EncryptedUploadV2WindowEndValue: Equatable, Sendable {
    let transportSessionID: UInt64
    let windowIndex: UInt32
    let firstSequence: UInt32
    let lastSequence: UInt32
    let nextCiphertextOffset: UInt64
    let prefixSHA256: Data
    let checkpointRevision: UInt32
}

struct EncryptedUploadV2ManifestChunkValue: Equatable, Sendable {
    let transportSessionID: UInt64
    let totalManifestLength: UInt16
    let chunkOffset: UInt16
    let manifestSHA256: Data
    let bytes: Data
}

struct EncryptedUploadV2EOFValue: Equatable, Sendable {
    let transportSessionID: UInt64
    let finalSequence: UInt32
    let blockCount: UInt32
    let ciphertextLength: UInt64
    let ciphertextSHA256: Data
    let manifestSHA256: Data
}

enum EncryptedUploadV2TransferPayloadValue: Equatable, Sendable {
    case data(EncryptedUploadV2DataValue)
    case windowEnd(EncryptedUploadV2WindowEndValue)
    case manifestChunk(EncryptedUploadV2ManifestChunkValue)
    case eof(EncryptedUploadV2EOFValue)
    case error(EncryptedUploadV2TransferErrorValue)
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
