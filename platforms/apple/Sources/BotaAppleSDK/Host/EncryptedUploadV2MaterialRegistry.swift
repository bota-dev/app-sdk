import CryptoKit
@preconcurrency import Foundation

struct EncryptedUploadV2TransferEvidence: Equatable, Sendable {
    let ciphertextLength: UInt64
    let ciphertextSHA256: Data
    let manifestLength: UInt16
    let manifestSHA256: Data
    let blockCount: UInt32

    init(
        ciphertextLength: UInt64,
        ciphertextSHA256: Data,
        manifestLength: UInt16,
        manifestSHA256: Data,
        blockCount: UInt32
    ) {
        self.ciphertextLength = ciphertextLength
        self.ciphertextSHA256 = ciphertextSHA256
        self.manifestLength = manifestLength
        self.manifestSHA256 = manifestSHA256
        self.blockCount = blockCount
    }
}

struct EncryptedUploadV2ManifestSubmission:
    CustomDebugStringConvertible, CustomStringConvertible, Equatable, Sendable
{
    let manifest: Data
    let evidence: EncryptedUploadV2TransferEvidence

    init(manifest: Data, evidence: EncryptedUploadV2TransferEvidence) {
        self.manifest = manifest
        self.evidence = evidence
    }

    var description: String { "EncryptedUploadV2ManifestSubmission(<redacted>)" }
    var debugDescription: String { description }
}

struct EncryptedUploadV2MaterialProvider:
    CustomDebugStringConvertible, CustomStringConvertible, Sendable
{
    typealias StagingRequestProvider = @Sendable (EncryptedUploadV2TransferEvidence) async throws -> URLRequest
    typealias ManifestSubmitter = @Sendable (EncryptedUploadV2ManifestSubmission) async throws -> Void
    typealias Finalizer = @Sendable (EncryptedUploadV2TransferEvidence) async throws -> Void
    typealias ReceiptProvider = @Sendable (EncryptedUploadV2TransferEvidence) async throws -> Data
    typealias CancellationHandler = @Sendable () async throws -> Void

    let authorization: Data
    private let stagingRequestProvider: StagingRequestProvider
    private let manifestSubmitter: ManifestSubmitter
    private let finalizer: Finalizer
    private let receiptProvider: ReceiptProvider
    private let cancellationHandler: CancellationHandler

    init(
        authorization: Data,
        stagingRequest: @escaping @Sendable (EncryptedUploadV2TransferEvidence) async throws -> URLRequest,
        submitManifest: @escaping @Sendable (EncryptedUploadV2ManifestSubmission) async throws -> Void,
        finalize: @escaping @Sendable (EncryptedUploadV2TransferEvidence) async throws -> Void,
        completionReceipt: @escaping @Sendable (EncryptedUploadV2TransferEvidence) async throws -> Data,
        cancel: @escaping @Sendable () async throws -> Void
    ) {
        self.authorization = authorization
        stagingRequestProvider = stagingRequest
        manifestSubmitter = submitManifest
        finalizer = finalize
        receiptProvider = completionReceipt
        cancellationHandler = cancel
    }

    var description: String { "EncryptedUploadV2MaterialProvider(<redacted>)" }
    var debugDescription: String { description }

    func stagingRequest(for evidence: EncryptedUploadV2TransferEvidence) async throws -> URLRequest {
        try await stagingRequestProvider(evidence)
    }

    func submit(_ submission: EncryptedUploadV2ManifestSubmission) async throws {
        try await manifestSubmitter(submission)
    }

    func finalize(_ evidence: EncryptedUploadV2TransferEvidence) async throws {
        try await finalizer(evidence)
    }

    func completionReceipt(_ evidence: EncryptedUploadV2TransferEvidence) async throws -> Data {
        try await receiptProvider(evidence)
    }

    func cancel() async throws {
        try await cancellationHandler()
    }
}

enum EncryptedUploadV2MaterialRegistryError: Error, Equatable, Sendable {
    case invalidMaterialID
    case duplicateMaterialID
    case missingMaterial
    case invalidAuthorization
    case invalidEvidence
    case invalidStagingRequest
    case invalidManifest
    case invalidReceipt
}

enum EncryptedUploadV2TerminalOutcome: CaseIterable, Equatable, Sendable {
    case completed
    case cancelled
    case failed
}

struct EncryptedUploadV2PreparedMaterial: Equatable, Sendable {
    let authorization: Data
    let authorizationSHA256: Data
}

struct EncryptedUploadV2AcceptedReceipt: Equatable, Sendable {
    let receipt: Data
    let receiptSHA256: Data
}

actor EncryptedUploadV2MaterialRegistry {
    private struct Entry: Sendable {
        let registrationID: UUID
        let provider: EncryptedUploadV2MaterialProvider
    }

    private static let authorizationByteCount = 408
    private static let manifestByteCount = 580
    private static let receiptByteCount = 336
    private static let digestByteCount = 32
    private static let maximumMaterialIDByteCount = 128

    private var providers: [String: Entry] = [:]

    func register(id: String, provider: EncryptedUploadV2MaterialProvider) throws {
        guard Self.isValidMaterialID(id) else {
            throw EncryptedUploadV2MaterialRegistryError.invalidMaterialID
        }
        guard provider.authorization.count == Self.authorizationByteCount else {
            throw EncryptedUploadV2MaterialRegistryError.invalidAuthorization
        }
        guard providers[id] == nil else {
            throw EncryptedUploadV2MaterialRegistryError.duplicateMaterialID
        }
        providers[id] = Entry(registrationID: UUID(), provider: provider)
    }

    func preparedMaterial(id: String) throws -> EncryptedUploadV2PreparedMaterial {
        let provider = try requiredEntry(id).provider
        return EncryptedUploadV2PreparedMaterial(
            authorization: provider.authorization,
            authorizationSHA256: Self.sha256(provider.authorization)
        )
    }

    func stagingRequest(
        id: String,
        evidence: EncryptedUploadV2TransferEvidence
    ) async throws -> URLRequest {
        try Self.validate(evidence)
        let entry = try requiredEntry(id)
        let request = try await entry.provider.stagingRequest(for: evidence)
        try requireCurrent(id: id, registrationID: entry.registrationID)
        guard request.url?.scheme?.lowercased() == "https",
              request.httpMethod?.uppercased() == "PUT",
              request.httpBody == nil,
              request.httpBodyStream == nil
        else {
            throw EncryptedUploadV2MaterialRegistryError.invalidStagingRequest
        }
        return request
    }

    func submitManifest(
        id: String,
        manifest: Data,
        evidence: EncryptedUploadV2TransferEvidence
    ) async throws {
        try Self.validate(evidence)
        guard manifest.count == Self.manifestByteCount,
              evidence.manifestLength == Self.manifestByteCount,
              Self.sha256(manifest) == evidence.manifestSHA256
        else {
            throw EncryptedUploadV2MaterialRegistryError.invalidManifest
        }
        let entry = try requiredEntry(id)
        try await entry.provider.submit(.init(manifest: manifest, evidence: evidence))
        try requireCurrent(id: id, registrationID: entry.registrationID)
    }

    func finalizeAndReceiveReceipt(
        id: String,
        evidence: EncryptedUploadV2TransferEvidence
    ) async throws -> EncryptedUploadV2AcceptedReceipt {
        try Self.validate(evidence)
        let entry = try requiredEntry(id)
        try await entry.provider.finalize(evidence)
        try requireCurrent(id: id, registrationID: entry.registrationID)
        let receipt = try await entry.provider.completionReceipt(evidence)
        try requireCurrent(id: id, registrationID: entry.registrationID)
        guard receipt.count == Self.receiptByteCount else {
            throw EncryptedUploadV2MaterialRegistryError.invalidReceipt
        }
        return EncryptedUploadV2AcceptedReceipt(
            receipt: receipt,
            receiptSHA256: Self.sha256(receipt)
        )
    }

    func terminate(id: String, outcome: EncryptedUploadV2TerminalOutcome) async throws {
        guard let entry = providers.removeValue(forKey: id) else { return }
        if outcome != .completed {
            try await entry.provider.cancel()
        }
    }

    func contains(id: String) -> Bool {
        providers[id] != nil
    }

    private func requiredEntry(_ id: String) throws -> Entry {
        guard let entry = providers[id] else {
            throw EncryptedUploadV2MaterialRegistryError.missingMaterial
        }
        return entry
    }

    private func requireCurrent(id: String, registrationID: UUID) throws {
        guard providers[id]?.registrationID == registrationID else {
            throw EncryptedUploadV2MaterialRegistryError.missingMaterial
        }
    }

    private static func validate(_ evidence: EncryptedUploadV2TransferEvidence) throws {
        guard evidence.ciphertextLength > 0,
              evidence.ciphertextSHA256.count == digestByteCount,
              evidence.manifestLength == manifestByteCount,
              evidence.manifestSHA256.count == digestByteCount,
              evidence.blockCount > 0
        else {
            throw EncryptedUploadV2MaterialRegistryError.invalidEvidence
        }
    }

    private static func isValidMaterialID(_ value: String) -> Bool {
        !value.isEmpty
            && value.utf8.count <= maximumMaterialIDByteCount
            && !value.contains(where: \Character.isWhitespace)
    }

    private static func sha256(_ data: Data) -> Data {
        Data(SHA256.hash(data: data))
    }
}
