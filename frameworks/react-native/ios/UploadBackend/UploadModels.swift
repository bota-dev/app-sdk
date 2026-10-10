import CryptoKit
import Foundation

enum UploadFailure: Error, LocalizedError, Equatable {
  case cancelled, invalidInput, identityConflict, transport, journal, invalidDocument, pending, expired, state, stagingMissing
  case http(Int)

  var errorDescription: String? {
    switch self {
    case .cancelled: "BOTA_UPLOAD_CANCELLED"
    case .invalidInput: "BOTA_UPLOAD_INVALID_INPUT"
    case .identityConflict: "BOTA_UPLOAD_IDENTITY_CONFLICT"
    case .transport: "BOTA_UPLOAD_TRANSPORT"
    case .journal: "BOTA_UPLOAD_JOURNAL"
    case .invalidDocument: "BOTA_UPLOAD_INVALID_DOCUMENT"
    case .pending: "BOTA_UPLOAD_PENDING"
    case .expired: "BOTA_UPLOAD_EXPIRED"
    case .state: "BOTA_UPLOAD_STATE"
    case .stagingMissing: "BOTA_UPLOAD_STAGING_MISSING"
    case .http(let status): "BOTA_UPLOAD_HTTP_\(status)"
    }
  }

  static func safe(_ error: Error) -> UploadFailure {
    if let error = error as? UploadFailure { return error }
    return error is CancellationError ? .cancelled : .transport
  }
  var transient: Bool {
    switch self {
    case .transport, .http(429), .http(500...599): true
    default: false
    }
  }
}

enum UploadValidation {
  static func matches(_ text: String, _ pattern: String) -> Bool {
    guard let range = text.range(of: pattern, options: .regularExpression) else { return false }
    return range.lowerBound == text.startIndex && range.upperBound == text.endIndex
  }
  static func uuid(_ value: String) -> Bool {
    matches(value, "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
  }
  static func hex(_ value: String, bytes: Int) -> Bool {
    value.utf8.count == bytes * 2 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
  static func bytes(_ hex: String) throws -> Data {
    guard hex.count % 2 == 0, self.hex(hex, bytes: hex.count / 2) else { throw UploadFailure.invalidInput }
    let chars = Array(hex.utf8)
    return Data(stride(from: 0, to: chars.count, by: 2).map {
      func nibble(_ c: UInt8) -> UInt8 { c <= 57 ? c - 48 : c - 87 }
      return nibble(chars[$0]) * 16 + nibble(chars[$0 + 1])
    })
  }
  static func hash(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
  static func integer(_ text: String, maximum: UInt64 = 9_007_199_254_740_991) throws -> UInt64 {
    guard matches(text, "^(0|[1-9][0-9]*)$"), let value = UInt64(text), value <= maximum else {
      throw UploadFailure.invalidInput
    }
    return value
  }
  static func document(_ base64: String?, hash: String? = nil, size: Int) throws -> Data {
    guard let base64, let data = Data(base64Encoded: base64), data.count == size,
          data.base64EncodedString() == base64,
          hash == nil || self.hash(data) == hash else { throw UploadFailure.invalidDocument }
    return data
  }
  static func date(_ value: String) throws -> Date {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    guard let date = formatter.date(from: value) else { throw UploadFailure.invalidDocument }
    return date
  }
}

struct UploadInput: Codable, Sendable {
  struct Scope: Codable, Sendable {
    var apiOrigin: String
    var apiBasePath: String?
    var accountId: String
    var projectId: String
    var organizationId: String
    var environment: String
    var endUserId: String
    var deviceId: String
    var bindingGeneration: UInt32
    var serialNumber: String
    var nativeDeviceId: String
    var scopeKey: String
  }
  struct Recording: Codable, Sendable {
    var uuid: String
    var generation: UInt32
    var ciphertextLength: String
    var ciphertextSha256: String
    var startedAtMs: String
    var durationMs: String
    var plaintextLength: String
    var storageFormat: UInt8
    var markersRequired: Bool? = nil
  }
  struct Capability: Codable, Sendable { var rawValueHex: String; var flags: UInt32 }
  struct Checkpoint: Codable, Sendable {
    var version: UInt32
    var uploadSessionId: String
    var ownerRevision: UInt32
    var revision: UInt32
    var nextCiphertextOffset: String
    var prefixSha256: String
    var highestContiguousSequence: UInt32?
    var transportSessionId: String
    var sinkRegistrationId: String
    var windowPackets: UInt16
    var dataPayloadBytes: UInt16
  }
  var operationId: String
  var scope: Scope
  var recording: Recording
  var capability: Capability
  var checkpoint: Checkpoint?
  var priorJournalEntry: UploadJournalEntry?
  var journalKey: String

  static func decode(_ data: Data) throws -> UploadInput {
    do {
      var object = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
      if object["journalKey"] == nil,
         let scope = object["scope"] as? [String: Any], let recording = object["recording"] as? [String: Any] {
        let fields = [scope["scopeKey"], scope["deviceId"], scope["bindingGeneration"], recording["uuid"],
          recording["generation"], recording["ciphertextLength"], recording["ciphertextSha256"]]
        guard fields.allSatisfy({ $0 != nil }) else { throw UploadFailure.invalidInput }
        object["journalKey"] = UploadValidation.hash(try JSONSerialization.data(
          withJSONObject: fields.map { $0! }, options: [.withoutEscapingSlashes]))
      }
      let input = try JSONDecoder().decode(Self.self, from: JSONSerialization.data(withJSONObject: object))
      try input.validate()
      return input
    } catch { throw (error as? UploadFailure) ?? .invalidInput }
  }

  func validate() throws {
    guard !operationId.isEmpty, operationId.utf8.count <= 128,
          let url = URLComponents(string: scope.apiOrigin), url.scheme == "https", url.host != nil,
          url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
          url.path.isEmpty, !scope.apiOrigin.hasSuffix("/"),
          [scope.accountId, scope.projectId, scope.environment, scope.endUserId, scope.deviceId,
           scope.serialNumber, scope.nativeDeviceId].allSatisfy({
            !$0.isEmpty && $0 != "." && $0 != ".." && $0.utf8.count <= 256 &&
              UploadValidation.matches($0, "^[A-Za-z0-9_.:@-]+$")
          }), !scope.scopeKey.isEmpty, scope.scopeKey.utf8.count <= 4096,
          UploadValidation.uuid(recording.uuid), recording.generation > 0,
          recording.storageFormat == 3, UploadValidation.hex(recording.ciphertextSha256, bytes: 32),
          UploadValidation.hex(capability.rawValueHex, bytes: 24),
          UploadValidation.hex(journalKey, bytes: 32) else { throw UploadFailure.invalidInput }
    guard scope.organizationId.isEmpty || UploadValidation.matches(scope.organizationId, "^[A-Za-z0-9_-]{1,256}$"),
          UploadValidation.matches(scope.apiBasePath ?? "/v1", "^(/[A-Za-z0-9_-]+)+$") else { throw UploadFailure.invalidInput }
    let length = try UploadValidation.integer(recording.ciphertextLength)
    let start = try UploadValidation.integer(recording.startedAtMs, maximum: 253_402_300_799_999)
    let duration = try UploadValidation.integer(recording.durationMs, maximum: 253_402_300_799_999)
    _ = try UploadValidation.integer(recording.plaintextLength)
    guard length > 0, duration <= 253_402_300_799_999 - start else { throw UploadFailure.invalidInput }
    let key: [Any] = [scope.scopeKey, scope.deviceId, scope.bindingGeneration, recording.uuid,
      recording.generation, recording.ciphertextLength, recording.ciphertextSha256]
    guard UploadValidation.hash(try JSONSerialization.data(withJSONObject: key, options: [.withoutEscapingSlashes])) == journalKey else {
      throw UploadFailure.identityConflict
    }
    try priorJournalEntry?.validate()
    if let checkpoint {
      guard checkpoint.version == 1, UploadValidation.uuid(checkpoint.uploadSessionId), checkpoint.ownerRevision > 0,
            checkpoint.ownerRevision <= 2_147_483_647,
            UploadValidation.hex(checkpoint.prefixSha256, bytes: 32),
            !checkpoint.sinkRegistrationId.isEmpty, checkpoint.sinkRegistrationId.utf8.count <= 128,
            checkpoint.windowPackets > 0, checkpoint.dataPayloadBytes > 0,
            try UploadValidation.integer(checkpoint.nextCiphertextOffset, maximum: .max) <= length,
            try UploadValidation.integer(checkpoint.transportSessionId, maximum: .max) > 0 else {
        throw UploadFailure.identityConflict
      }
    }
  }

  func identity(includeTransport: Bool = false) throws -> String {
    struct Identity: Encodable { let scope: Scope; let recording: Recording }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    var identityScope = scope
    if !includeTransport { identityScope.nativeDeviceId = "" }
    var identityRecording = recording
    if identityRecording.markersRequired == false { identityRecording.markersRequired = nil }
    return UploadValidation.hash(try encoder.encode(Identity(scope: identityScope, recording: identityRecording)))
  }

  func validateCheckpoint(_ entry: UploadJournalEntry?) throws {
    guard let checkpoint else { return }
    guard let id = entry?.sessionId, let revision = entry?.ownerRevision,
          checkpoint.ownerRevision <= revision,
          (checkpoint.ownerRevision == revision) == (checkpoint.uploadSessionId == id) else {
      throw UploadFailure.identityConflict
    }
  }
}

struct UploadJournalEntry: Codable, Equatable, Sendable {
  var recordingId: String
  var sessionId: String?
  var ownerRevision: UInt32?

  func agrees(with entry: UploadJournalEntry) -> Bool {
    recordingId == entry.recordingId && (sessionId == nil || sessionId == entry.sessionId) &&
      (ownerRevision == nil || ownerRevision == entry.ownerRevision)
  }

  func identity() throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return UploadValidation.hash(try encoder.encode(self))
  }

  func validate() throws {
    guard UploadValidation.matches(recordingId, "^rec_[A-Za-z0-9_-]+$"), recordingId.count <= 256 else {
      throw UploadFailure.identityConflict
    }
    if let sessionId {
      guard UploadValidation.uuid(sessionId), let ownerRevision, ownerRevision > 0,
            ownerRevision <= 2_147_483_647 else { throw UploadFailure.identityConflict }
    } else if ownerRevision != nil { throw UploadFailure.identityConflict }
  }
}

struct UploadSession: Decodable, Sendable {
  let profile: String
  let session_id: String
  let owner_revision: UInt32
  let policy: String
  let authorization_base64: String
  let authorization_sha256: String
  let expires_at: String
  let state: String?
  let channel: String?
  let ciphertext_length: UInt64?
  let ciphertext_sha256: String?
  let plaintext_length: UInt64?
  let completion_receipt_base64: String?
  let completion_receipt_sha256: String?
  let marker_completion_receipt_base64: String?
  let marker_completion_receipt_sha256: String?

  func validatePointer() throws {
    guard profile == "encrypted_upload_v2", UploadValidation.uuid(session_id), owner_revision > 0,
          owner_revision <= 2_147_483_647,
          ["legacy_allowed", "v2_preferred", "v2_required"].contains(policy) else { throw UploadFailure.invalidDocument }
  }
  func validateIdentity(_ entry: UploadJournalEntry, recording: UploadInput.Recording) throws {
    try validatePointer()
    guard session_id == entry.sessionId, owner_revision == entry.ownerRevision,
          channel == "ble", ciphertext_length == UInt64(recording.ciphertextLength),
          ciphertext_sha256 == recording.ciphertextSha256 else { throw UploadFailure.identityConflict }
  }
  func actions() throws -> (upload: Bool, manifest: Bool) {
    switch state {
    case "staging": (true, true)
    case "staged": (false, true)
    case "ready", "processing", "published": (false, false)
    case "expired": throw UploadFailure.expired
    default: throw UploadFailure.state
    }
  }
}

struct UploadEvidence: Sendable {
  let ciphertextLength: UInt64
  let ciphertextSHA256: Data
  let manifestLength: UInt16
  let manifestSHA256: Data
}
