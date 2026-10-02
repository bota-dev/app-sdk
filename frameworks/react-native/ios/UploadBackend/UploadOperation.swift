import CryptoKit
import Foundation

struct UploadPrepared: Sendable {
  let session: UploadSession
  let authorization: Data
  let recordingId: String
}

struct UploadContext: Sendable {
  let challenge: Data
  let exchangeProof: @Sendable (Data) async throws -> Data
}

@MainActor final class UploadOperation {
  let input: UploadInput
  private let journal: UploadJournal
  private let http: any UploadHTTP
  private let credentials: UploadCredentials
  private let readNonce: @Sendable (String) async throws -> Data
  private let wait: @Sendable (UInt64) async throws -> Void
  private let now: @Sendable () -> Date
  private var cancelled = false
  private var tasks: [UUID: Task<UploadHTTPResponse, Error>] = [:]
  private var entry: UploadJournalEntry?
  private var session: UploadSession?
  private var authorizationNonceSHA256: String?
  private var recoveryNonceBase64: String?
  private var uploadCiphertext = true
  private var needsManifest = true
  private var receipt: Data?
  private var receiptDelivered = false

  init(input: UploadInput, journal: UploadJournal, http: any UploadHTTP, credentials: UploadCredentials,
       readNonce: @escaping @Sendable (String) async throws -> Data,
       wait: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0 * 1_000_000) },
       now: @escaping @Sendable () -> Date = { Date() }) {
    self.input = input
    self.journal = journal
    self.http = http
    self.credentials = credentials
    self.readNonce = readNonce
    self.wait = wait
    self.now = now
  }

  func cancel() {
    cancelled = true
    credentials.cancel(operationId: input.operationId)
    tasks.values.forEach { $0.cancel() }
  }

  func check() throws {
    guard !cancelled, !Task.isCancelled else { throw UploadFailure.cancelled }
  }

  private var base: String { input.scope.apiBasePath ?? "/v1" }
  private var contexts: String { "\(base)/devices/\(input.scope.deviceId)/encrypted-upload-v2/contexts" }
  private func sessions(_ recordingId: String) -> String { "\(base)/recordings/\(recordingId)/encrypted-upload-v2/sessions" }
  private func sessionPath() throws -> String {
    guard let entry, let id = entry.sessionId else { throw UploadFailure.state }
    return sessions(entry.recordingId) + "/" + id
  }

  private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                       drain: Bool = false, beforeDispatch: (() throws -> Void)? = nil,
                       onAuthorizationRejection: (() throws -> Void)? = nil) async throws -> Data {
    try check()
    let token = try await credentials.request(operationId: input.operationId)
    try check()
    guard let url = URL(string: input.scope.apiOrigin + path) else { throw UploadFailure.invalidInput }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if !input.scope.organizationId.isEmpty {
      request.setValue(input.scope.organizationId, forHTTPHeaderField: "X-Organization-Id")
    }
    if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
    try beforeDispatch?()
    let id = UUID()
    let task = Task {
      try self.check()
      return try await http.send(request)
    }
    // Unstructured draining tasks are deliberately not cancelled after dispatch.
    // The caller commits their response IDs before checking account cancellation.
    if !drain { tasks[id] = task }
    defer { tasks[id] = nil }
    do {
      let response = try await withTaskCancellationHandler { try await task.value } onCancel: {
        if !drain { task.cancel() }
        Task { @MainActor in self.cancel() }
      }
      if !drain { try check() }
      if [401, 403].contains(response.status), let onAuthorizationRejection {
        try check()
        try onAuthorizationRejection()
      }
      if response.status == 409,
         let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any],
         let error = object["error"] as? [String: Any],
         error["code"] as? String == "encrypted_upload_v2_staging_missing" { throw UploadFailure.stagingMissing }
      guard (200...299).contains(response.status) else { throw UploadFailure.http(response.status) }
      return response.body
    } catch {
      if !drain { try check() }
      throw UploadFailure.safe(error)
    }
  }

  private func decode<T: Decodable>(_ data: Data, as: T.Type = T.self) throws -> T {
    do { return try JSONDecoder().decode(T.self, from: data) }
    catch { throw UploadFailure.invalidDocument }
  }

  private func retry<T>(_ operation: () async throws -> T) async throws -> T {
    for attempt in 0..<3 {
      try check()
      do { let result = try await operation(); try check(); return result }
      catch {
        try check()
        let error = UploadFailure.safe(error)
        guard error.transient, attempt < 2 else { throw error }
        try await wait(250)
      }
    }
    throw UploadFailure.pending
  }

  private func nonce() async throws -> String {
    try check()
    let data: Data
    do { data = try await readNonce(input.operationId) }
    catch { try check(); throw UploadFailure.safe(error) }
    try check()
    guard data.count == 16 else { throw UploadFailure.invalidDocument }
    return data.base64EncodedString()
  }

  func prepare() async throws -> UploadPrepared {
    try check()
    try input.validate()
    entry = try journal.load(input)
    authorizationNonceSHA256 = try journal.authorizationNonceSHA256(input)
    recoveryNonceBase64 = try journal.recoveryNonceBase64(input)
    if entry == nil { entry = input.priorJournalEntry }
    try input.validateCheckpoint(entry)
    if let entry { try journal.save(input, entry: entry, recoveryNonceBase64: recoveryNonceBase64) }
    if entry == nil {
      let start = Double(try UploadValidation.integer(input.recording.startedAtMs))
      let end = start + Double(try UploadValidation.integer(input.recording.durationMs))
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      let data = try await request(base + "/recordings", method: "POST", body: [
        "device_id": input.scope.deviceId, "end_user_id": input.scope.endUserId,
        "upload_method": "ble", "streaming": false,
        "metadata": ["started_at": formatter.string(from: Date(timeIntervalSince1970: start / 1000)),
          "ended_at": formatter.string(from: Date(timeIntervalSince1970: end / 1000))],
      ], drain: true, beforeDispatch: { try self.journal.markUnknown(self.input, entry: nil) },
        onAuthorizationRejection: { try self.journal.rollbackRejectedCreate(self.input, entry: nil) })
      struct Created: Decodable { let id: String }
      let created = try decode(data, as: Created.self)
      let committed = UploadJournalEntry(recordingId: created.id)
      try committed.validate()
      try journal.save(input, entry: committed)
      entry = committed
    }
    try check()
    guard let initial = entry else { throw UploadFailure.state }
    let selected: UploadSession
    if initial.sessionId != nil {
      selected = try await restore()
      let actions = try selected.actions()
      uploadCiphertext = actions.upload
      needsManifest = actions.manifest
    } else {
      let nonce = try await nonce()
      let body: [String: Any] = [
        "device_id": input.scope.deviceId, "end_user_id": input.scope.endUserId, "binding_generation": input.scope.bindingGeneration,
        "recording_uuid": input.recording.uuid, "recording_generation": input.recording.generation,
        "storage_format": "bota_enc_v2", "channel": "ble",
        "capabilities_base64": try UploadValidation.bytes(input.capability.rawValueHex).base64EncodedString(),
        "auth_nonce_base64": nonce, "ciphertext_length": try UploadValidation.integer(input.recording.ciphertextLength),
        "ciphertext_sha256": input.recording.ciphertextSha256,
      ]
      let data = try await request(sessions(initial.recordingId), method: "POST", body: body, drain: true,
        beforeDispatch: { try self.journal.markUnknown(self.input, entry: initial) },
        onAuthorizationRejection: { try self.journal.rollbackRejectedCreate(self.input, entry: initial) })
      let pointer = try decode(data, as: Pointer.self)
      let committed = try pointer.entry(recordingId: initial.recordingId)
      let nonceHash = UploadValidation.hash(try UploadValidation.document(nonce, size: 16))
      try journal.save(input, entry: committed, authorizationNonceSHA256: nonceHash)
      authorizationNonceSHA256 = nonceHash
      entry = committed
      try check()
      selected = try decode(data)
    }
    try check()
    try selected.validatePointer()
    _ = try UploadValidation.date(selected.expires_at)
    guard UploadValidation.hex(selected.authorization_sha256, bytes: 32) else { throw UploadFailure.invalidDocument }
    let authorization = try UploadValidation.document(selected.authorization_base64, hash: selected.authorization_sha256, size: 408)
    session = selected
    return UploadPrepared(session: selected, authorization: authorization, recordingId: initial.recordingId)
  }

  private struct Pointer: Decodable {
    let profile: String
    let session_id: String
    let owner_revision: UInt32
    func entry(recordingId: String) throws -> UploadJournalEntry {
      guard profile == "encrypted_upload_v2" else { throw UploadFailure.invalidDocument }
      let entry = UploadJournalEntry(recordingId: recordingId, sessionId: session_id, ownerRevision: owner_revision)
      try entry.validate()
      return entry
    }
  }

  private func restore() async throws -> UploadSession {
    var visited = Set<String>()
    for hop in 0...3 {
      guard let parent = entry, let id = parent.sessionId, let revision = parent.ownerRevision else { throw UploadFailure.state }
      visited.insert(id)
      let status: UploadSession = try decode(await retry { try await request(try sessionPath()) })
      try status.validateIdentity(parent, recording: input.recording)
      let expiry = try UploadValidation.date(status.expires_at)
      let preManifest = ["created", "staging", "staged"].contains(status.state ?? "")
      let expired = status.state == "expired" || (preManifest && expiry <= now())
      if recoveryNonceBase64 == nil && !expired && !(preManifest && authorizationNonceSHA256 != nil) { return status }
      let nonce: String
      if let pending = recoveryNonceBase64 { nonce = pending }
      else { nonce = try await self.nonce() }
      let nonceHash = UploadValidation.hash(try UploadValidation.document(nonce, size: 16))
      let nonceChanged = authorizationNonceSHA256 != nil && nonceHash != authorizationNonceSHA256
      if recoveryNonceBase64 == nil && !expired && !nonceChanged { return status }
      guard input.capability.flags & 0x37f == 0x37f, hop < 3 else { throw UploadFailure.expired }
      var body: [String: Any] = ["owner_revision": revision, "auth_nonce_base64": nonce,
        "capabilities_base64": try UploadValidation.bytes(input.capability.rawValueHex).base64EncodedString()]
      if !expired { body["reason"] = "nonce_changed" }
      let path = sessions(parent.recordingId) + "/" + id + "/recover"
      // The public challenge nonce lets a lost response retry the exact request.
      try journal.save(input, entry: parent, recoveryNonceBase64: nonce)
      recoveryNonceBase64 = nonce
      try await retry {
        let pointer: Pointer = try self.decode(await self.request(path, method: "POST", body: body, drain: true))
        let successor = try pointer.entry(recordingId: parent.recordingId)
        guard pointer.owner_revision > revision, !visited.contains(pointer.session_id) else { throw UploadFailure.identityConflict }
        try self.journal.save(self.input, entry: successor, authorizationNonceSHA256: nonceHash)
        self.entry = successor
        self.authorizationNonceSHA256 = nonceHash
        self.recoveryNonceBase64 = nil
      }
    }
    throw UploadFailure.expired
  }

  private func verify(_ evidence: UploadEvidence) throws {
    try check()
    guard session != nil, evidence.ciphertextLength == UInt64(input.recording.ciphertextLength),
          evidence.ciphertextSHA256 == (try UploadValidation.bytes(input.recording.ciphertextSha256)) else {
      throw UploadFailure.identityConflict
    }
  }

  func shouldUpload(_ evidence: UploadEvidence) throws -> Bool { try verify(evidence); return uploadCiphertext }

  func reconcileStaging(_ manifest: Data, evidence: UploadEvidence) async throws -> Bool {
    try verify(evidence)
    guard uploadCiphertext else { return false }
    do {
      try await retry { try await submitManifest(manifest, evidence: evidence) }
      return false
    } catch UploadFailure.stagingMissing { return true }
  }

  func stagingRequest(_ evidence: UploadEvidence) async throws -> URLRequest {
    try verify(evidence)
    guard uploadCiphertext, let session else { throw UploadFailure.state }
    guard try UploadValidation.date(session.expires_at) > now() else { throw UploadFailure.expired }
    struct Target: Decodable { let url: String; let method: String; let headers: [String: String] }
    let target: Target = try decode(await request(try sessionPath() + "/staging-url", method: "POST",
      body: ["owner_revision": session.owner_revision]))
    try check()
    guard try UploadValidation.date(session.expires_at) > now() else { throw UploadFailure.expired }
    guard target.method == "PUT", let components = URLComponents(string: target.url), components.scheme == "https",
          components.host != nil, components.user == nil, components.password == nil, components.fragment == nil,
          let url = components.url else { throw UploadFailure.invalidDocument }
    var request = URLRequest(url: url)
    request.httpMethod = "PUT"
    for (name, value) in target.headers {
      guard UploadValidation.matches(name, "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$"),
            !value.contains("\r"), !value.contains("\n"), !value.contains("\0"),
            !["authorization", "cookie", "proxy-authorization"].contains(name.lowercased()) else {
        throw UploadFailure.invalidDocument
      }
      request.setValue(value, forHTTPHeaderField: name)
    }
    return request
  }

  func submitManifest(_ manifest: Data, evidence: UploadEvidence) async throws {
    try verify(evidence)
    guard manifest.count == 580, evidence.manifestLength == 580, evidence.manifestSHA256.count == 32,
          Data(SHA256.hash(data: manifest)) == evidence.manifestSHA256 else { throw UploadFailure.invalidDocument }
    guard needsManifest, let session else { return }
    _ = try await request(try sessionPath() + "/manifest", method: "POST", body: [
      "owner_revision": session.owner_revision, "manifest_base64": manifest.base64EncodedString(),
      "manifest_sha256": UploadValidation.hash(manifest),
    ])
    uploadCiphertext = false
    needsManifest = false
  }

  func finalize(_ evidence: UploadEvidence) async throws {
    try verify(evidence)
    guard let entry else { throw UploadFailure.state }
    for _ in 0..<60 {
      let status: UploadSession = try decode(await retry { try await request(try sessionPath()) })
      try status.validateIdentity(entry, recording: input.recording)
      _ = try status.actions()
      if status.state == "published" {
        guard status.plaintext_length == UInt64(input.recording.plaintextLength),
              let hash = status.completion_receipt_sha256, UploadValidation.hex(hash, bytes: 32) else {
          throw UploadFailure.invalidDocument
        }
        receipt = try UploadValidation.document(status.completion_receipt_base64, hash: hash, size: 336)
        return
      }
      try await wait(2000)
      try check()
    }
    throw UploadFailure.pending
  }

  func completionReceipt(_ evidence: UploadEvidence) throws -> Data {
    try verify(evidence)
    guard let receipt else { throw UploadFailure.state }
    receiptDelivered = true
    return receipt
  }

  func complete() throws {
    try check()
    guard receiptDelivered, let entry else { throw UploadFailure.state }
    try journal.remove(input, expected: entry)
  }

  private struct ContextStatus: Decodable, Sendable {
    let context_id: String
    let state: String
    let challenge_base64: String
    let result_base64: String?
    let expires_at: String
  }

  func uploadContext(_ nonce: Data) async throws -> UploadContext {
    try check()
    guard nonce.count == 16 else { throw UploadFailure.invalidDocument }
    let initial: ContextStatus = try await retry {
      try self.decode(await self.request(self.contexts, method: "POST", body: ["nonce_base64": nonce.base64EncodedString()]))
    }
    guard UploadValidation.uuid(initial.context_id), ["challenge", "pending", "complete"].contains(initial.state) else {
      throw UploadFailure.invalidDocument
    }
    _ = try UploadValidation.date(initial.expires_at)
    let challenge = try UploadValidation.document(initial.challenge_base64, size: 196)
    return UploadContext(challenge: challenge, exchangeProof: { proof in try await self.exchange(proof, initial: initial) })
  }

  private func exchange(_ proof: Data, initial: ContextStatus) async throws -> Data {
    try check()
    guard (116...366).contains(proof.count) else { throw UploadFailure.invalidDocument }
    let path = contexts + "/" + initial.context_id
    var value: ContextStatus = try await retry {
      try self.decode(await self.request(path + "/proof", method: "POST", body: ["proof_base64": proof.base64EncodedString()]))
    }
    for poll in 0...100 {
      try check()
      guard value.context_id == initial.context_id, value.challenge_base64 == initial.challenge_base64,
            value.expires_at == initial.expires_at, ["pending", "complete"].contains(value.state),
            value.state != "pending" || value.result_base64 == nil else { throw UploadFailure.invalidDocument }
      if value.state == "complete" { return try UploadValidation.document(value.result_base64, size: 264) }
      if poll == 100 { break }
      try await wait(250)
      value = try await retry { try self.decode(await self.request(path)) }
    }
    throw UploadFailure.pending
  }
}
