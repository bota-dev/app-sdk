import Foundation
import CryptoKit
import Darwin

private func expect(_ condition: Bool, _ label: String) throws {
  if !condition { throw TestFailure(label: label) }
}
private struct TestFailure: Error { let label: String }
@MainActor private func rejects(_ code: UploadFailure, _ body: () async throws -> Void) async throws {
  do { try await body(); throw TestFailure(label: "Expected fixed failure") }
  catch let error as UploadFailure {
    try expect(error == code, "Expected \(code.errorDescription!), received \(error.errorDescription!)")
  }
}

@MainActor
private final class FakeHTTP: UploadHTTP {
  var requests: [URLRequest] = []
  var handler: (URLRequest) async throws -> UploadHTTPResponse = { _ in throw UploadFailure.transport }
  func send(_ request: URLRequest) async throws -> UploadHTTPResponse {
    requests.append(request)
    return try await handler(request)
  }
}

@main
private struct AppleUploadTests {
  @MainActor static func main() async throws {
    try await protectedStreamingStatus()
    try await journalAndCredentials()
    try await prepareAndResume()
    try await reconnectJournalIdentity()
    try await nonceRecovery()
    try await cancellationDrain()
    try await documentsAndExpiry()
    try await contextsAndBounds()
    try await stagingAndDurability()
    try await coordinatorLifetime()
    try await recoveryAndCancellationBounds()
    try await importedPriorSurvivesRecovery()
    try await invalidInputsAndReceipts()
    try await createRejectionRollback()
    try await uncertainCreateRetention()
    try await rollbackGuardsAndDurability()
    try await manifestReconciliation()
    try await markedUpload()
    try await markedAdmissionRecovery()
    try await markedSuccessorCompletionFences()
    try await markedPostManifestAdmissionFences()
    print("PASS Apple upload: 21 suites including protected streaming status and marked recovery fences")
  }

  @MainActor private static func protectedStreamingStatus() async throws {
    let http = FakeHTTP()
    let provider = UploadStreamingStatus(http: http)
    let input: [String: Any] = ["url": "https://api.example/dashboard/projects/proj_a/recordings/rec_a/streaming-status?session_id=12345678-1234-4234-8234-123456789012", "token": "app-token", "organizationId": "org_a"]
    let request = String(decoding: try JSONSerialization.data(withJSONObject: input), as: UTF8.self)
    var payload: [String: Any] = ["profile": "recording_markers_stream_v1", "recording_id": "rec_a",
      "session_id": "12345678-1234-4234-8234-123456789012", "recording_generation": 1, "writer_epoch": "1",
      "revision": "9007199254740993", "received_count": 0, "contiguous_sequence": 0,
      "state": "open", "expected_count": NSNull(), "authorization_expired": false]
    let good = try JSONSerialization.data(withJSONObject: payload)
    http.handler = { _ in UploadHTTPResponse(status: 200, body: good) }
    let result = try await provider.read(request)
    try expect(result.contains("9007199254740993"), "Lossless revision")
    try expect(http.requests[0].httpMethod == "GET" && http.requests[0].value(forHTTPHeaderField: "X-Organization-Id") == "org_a", "Scoped GET")
    for status in [302, 401, 403, 404, 503] {
      http.handler = { _ in UploadHTTPResponse(status: status, body: Data()) }
      try await rejects(.http(status)) { _ = try await provider.read(request) }
    }
    try expect(http.requests.count == 6, "No auth fallback")
    payload["authorization"] = "must-stay-native"
    let opaque = try JSONSerialization.data(withJSONObject: payload)
    http.handler = { _ in UploadHTTPResponse(status: 200, body: opaque) }
    try await rejects(.invalidDocument) { _ = try await provider.read(request) }
    http.handler = { _ in UploadHTTPResponse(status: 200, body: Data(repeating: 32, count: 16385)) }
    try await rejects(.invalidDocument) { _ = try await provider.read(request) }
    try await rejects(.invalidInput) { _ = try await provider.read(request.replacingOccurrences(of: "https", with: "http")) }
  }

  @MainActor private static func markedAdmissionRecovery() async throws {
    for readStatus in [200, 404, 403, 409] {
      let (ordinary, journal, root, http, credentials) = try fixture()
      defer { try? FileManager.default.removeItem(at: root) }
      var input = ordinary
      input.recording.markersRequired = true
      var posts = 0
      http.handler = { request in
        if request.url!.path.hasSuffix("/recordings") { return try json(["id": "rec_one"]) }
        if request.url!.path.hasSuffix("/markers/authorization") {
          if request.httpMethod == "GET" && readStatus != 200 { return UploadHTTPResponse(status: readStatus, body: Data()) }
          if request.httpMethod == "POST" { posts += 1 }
          let bytes = Data(repeating: 3, count: 280)
          return try json(["profile": "recording-markers/1", "context_base64": Data(repeating: 0, count: 176).base64EncodedString(),
            "authorization_base64": bytes.base64EncodedString(), "authorization_sha256": UploadValidation.hash(bytes)])
        }
        return try json(session("staging"))
      }
      let op = operation(input, journal, http, credentials)
      if [403, 409].contains(readStatus) { try await rejects(.http(readStatus)) { _ = try await op.prepare() } }
      else { _ = try await op.prepare() }
      try expect(posts == (readStatus == 404 ? 1 : 0), "Only explicit absence allows a new marker admission")
    }
  }

  @MainActor private static func markedSuccessorCompletionFences() async throws {
    for invalid in ["owner", "wifi", "cellular", "marker-hash"] {
      let (ordinary, journal, root, http, credentials) = try fixture()
      defer { try? FileManager.default.removeItem(at: root) }
      var input = ordinary
      input.recording.markersRequired = true
      try journal.save(input, entry: .init(recordingId: "rec_one", sessionId: sessionID, ownerRevision: 1))
      let child = "33333333-3333-3333-3333-333333333333"
      let context = Data(repeating: 4, count: 176)
      let markerAuth = Data(repeating: 3, count: 280)
      http.handler = { request in
        let path = request.url!.path
        if path.hasSuffix("/markers/authorization") {
          try expect(request.httpMethod == "GET" && path.hasSuffix(child + "/markers/authorization") &&
            request.url!.query == "owner_revision=2", "Successor restores its own persisted admission")
          return try json(["profile": "recording-markers/1", "context_base64": context.base64EncodedString(),
            "authorization_base64": markerAuth.base64EncodedString(), "authorization_sha256": UploadValidation.hash(markerAuth)])
        }
        if path.hasSuffix(sessionID + "/recover") {
          let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
          try expect(body["owner_revision"] as? Int == 1, "Recover exact parent owner")
        }
        var status = session(path.hasSuffix(sessionID) ? "expired" : "staging")
        if path.hasSuffix(child) || path.hasSuffix("/recover") {
          status["session_id"] = child
          status["owner_revision"] = 2
        }
        return try json(status)
      }
      let op = operation(input, journal, http, credentials)
      let prepared = try await op.prepare()
      try expect(prepared.session.session_id == child && prepared.session.owner_revision == 2, "Select durable successor")
      try expect(prepared.authorization == Data(repeating: 1, count: 408) + context + markerAuth, "Preserve successor admission bytes")
      let retained = try journal.load(input)
      try expect(retained?.sessionId == child && retained?.ownerRevision == 2, "Persist successor before admission")
      http.handler = { request in
        try expect(request.url!.path.hasSuffix(child), "Poll only selected successor")
        var status = session("published")
        status["session_id"] = invalid == "owner" ? sessionID : child
        status["owner_revision"] = invalid == "owner" ? 1 : 2
        status["channel"] = ["wifi", "cellular"].contains(invalid) ? invalid : "ble"
        status["plaintext_length"] = 256
        let audio = Data(repeating: 6, count: 336)
        status["completion_receipt_base64"] = audio.base64EncodedString()
        status["completion_receipt_sha256"] = UploadValidation.hash(audio)
        status["marker_completion_receipt_base64"] = Data(repeating: 5, count: 296).base64EncodedString()
        status["marker_completion_receipt_sha256"] = String(repeating: "0", count: 64)
        return try json(status)
      }
      let evidence = UploadEvidence(ciphertextLength: 512, ciphertextSHA256: Data(repeating: 0xaa, count: 32),
        manifestLength: 580, manifestSHA256: Data(repeating: 0, count: 32))
      try await rejects(invalid == "marker-hash" ? .invalidDocument : .identityConflict) { try await op.finalize(evidence) }
      try await rejects(.state) { _ = try op.completionReceipt(evidence) }
      try await rejects(.state) { try op.complete() }
      try expect(try journal.load(input) == retained, "Rejected completion retains exact successor journal")
      try expect(http.requests.filter { $0.url!.path.hasSuffix("/recover") }.count == 1, "One successor request")
      try expect(!http.requests.contains { $0.url!.path.hasSuffix("/markers/authorization") && $0.httpMethod == "POST" },
        "Saved child admission never recreated")
      op.cancel()
    }
  }

  @MainActor private static func markedPostManifestAdmissionFences() async throws {
    for state in ["staging", "ready", "processing", "published"] {
      for readStatus in [404, 503] {
        if state == "staging" && readStatus == 404 { continue }
        let (ordinary, journal, root, http, credentials) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        var input = ordinary
        input.recording.markersRequired = true
        let retained = UploadJournalEntry(recordingId: "rec_one", sessionId: sessionID, ownerRevision: 1)
        try journal.save(input, entry: retained)
        http.handler = { request in
          try expect(request.httpMethod == "GET", "Failure never reopens admission")
          if request.url!.path.hasSuffix("/markers/authorization") { return try json([:], status: readStatus) }
          return try json(session(state))
        }
        try await rejects(.http(readStatus)) { _ = try await operation(input, journal, http, credentials).prepare() }
        try expect(try journal.load(input) == retained, "Failed admission lookup retains owner")
      }
    }
  }

  @MainActor private static func markedUpload() async throws {
    let (ordinary, journal, root, http, credentials) = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    var input = ordinary
    input.recording.markersRequired = true
    let markerAuthorization = Data(repeating: 3, count: 280)
    let context = Data(repeating: 4, count: 176)
    let markerReceipt = Data(repeating: 5, count: 296)
    let audioReceipt = Data(repeating: 6, count: 336)
    var published = false
    var includeMarkerReceipt = false
    var batches = 0
    http.handler = { request in
      let path = request.url!.path
      if path.hasSuffix("/recordings") { return try json(["id": "rec_one"]) }
      if path.hasSuffix("/markers/authorization") {
        return try json(["profile": "recording-markers/1", "context_base64": context.base64EncodedString(),
          "authorization_base64": markerAuthorization.base64EncodedString(),
          "authorization_sha256": UploadValidation.hash(markerAuthorization)])
      }
      if path.hasSuffix("/markers/batch") {
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
        try expect((body["pages_base64"] as? [String])?.count == 1, "Native marker page forwarding")
        batches += 1
        return try json(["state": "verified"])
      }
      var status = session(published ? "published" : "staging")
      if published {
        status["plaintext_length"] = 256
        status["completion_receipt_base64"] = audioReceipt.base64EncodedString()
        status["completion_receipt_sha256"] = UploadValidation.hash(audioReceipt)
        if includeMarkerReceipt {
          status["marker_completion_receipt_base64"] = markerReceipt.base64EncodedString()
          status["marker_completion_receipt_sha256"] = UploadValidation.hash(markerReceipt)
        }
      }
      return try json(status)
    }
    let op = operation(input, journal, http, credentials)
    let prepared = try await op.prepare()
    try expect(prepared.authorization == Data(repeating: 1, count: 408) + context + markerAuthorization, "Marked bundle order")
    let evidence = UploadEvidence(ciphertextLength: 512, ciphertextSHA256: Data(repeating: 0xaa, count: 32),
      manifestLength: 580, manifestSHA256: Data(repeating: 0, count: 32))
    try await rejects(.invalidDocument) { try await op.submitMarkers([Data(repeating: 0, count: 200)], evidence: evidence) }
    try await op.submitMarkers([Data(repeating: 0, count: 200), Data(repeating: 0, count: 216)], evidence: evidence)
    try expect(batches == 1, "Incomplete metadata never submitted")
    published = true
    try await rejects(.invalidDocument) { try await op.finalize(evidence) }
    try await rejects(.state) { _ = try op.completionReceipt(evidence) }
    try expect(try journal.load(input) != nil, "Audio-only completion retains journal")
    includeMarkerReceipt = true
    try await op.finalize(evidence)
    try expect(try op.completionReceipt(evidence) == audioReceipt + markerReceipt, "Exact dual completion")
    var explicitFalse = ordinary
    explicitFalse.recording.markersRequired = false
    try expect(try ordinary.identity() == explicitFalse.identity(), "Ordinary journal remains compatible")
    try expect(try ordinary.identity() != input.identity(), "Marker requirement bound to journal identity")
  }

  static func input() throws -> UploadInput {
    let value: [String: Any] = [
      "operationId": "operation-1",
      "scope": ["apiOrigin": "https://api.example.test", "accountId": "account-a",
        "projectId": "project_a", "organizationId": "org_a", "environment": "production", "endUserId": "eu_a",
        "deviceId": "dev_a", "bindingGeneration": 1, "serialNumber": "BOTA001",
        "nativeDeviceId": "native-a", "scopeKey": "scope-a"],
      "recording": ["uuid": "11111111-1111-1111-1111-111111111111", "generation": 1,
        "ciphertextLength": "512", "ciphertextSha256": String(repeating: "a", count: 64),
        "startedAtMs": "1700000000000", "durationMs": "1000", "plaintextLength": "256", "storageFormat": 3],
      "capability": ["rawValueHex": "020018007f03000000000000000000000000000000000000", "flags": 895],
      "journalKey": "5907f335eb5d6e6fc68b2e498f6c24a5b71e4d639a782d4bf680803c044a7d394",
    ]
    var data = value
    let keyFields: [Any] = ["scope-a", "dev_a", 1, "11111111-1111-1111-1111-111111111111", 1,
      "512", String(repeating: "a", count: 64)]
    data["journalKey"] = SHA256.hash(data: try JSONSerialization.data(withJSONObject: keyFields,
      options: [.withoutEscapingSlashes])).map { String(format: "%02x", $0) }.joined()
    return try UploadInput.decode(JSONSerialization.data(withJSONObject: data))
  }

  @MainActor static func journalAndCredentials() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let value = try input()
    let journal = UploadJournal(root: root)
    try expect(try journal.load(value) == nil, "New journal is absent")
    let entry = UploadJournalEntry(recordingId: "rec_one", sessionId: nil, ownerRevision: nil)
    try journal.save(value, entry: entry)
    try expect(try UploadJournal(root: root).load(value) == entry, "Restart recovers recording")
    let content = try String(contentsOf: root.appendingPathComponent(value.journalKey + ".json"), encoding: .utf8)
    try expect(!content.contains("https:") && !content.contains("scope-a"), "Journal excludes origin/scope strings")
    let attributes = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent(value.journalKey + ".json").path)
    try expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "Private journal permissions")
    try expect(try root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true, "Backup exclusion")
    var conflict = value
    conflict.scope.accountId = "account-b"
    try await rejects(.identityConflict) { _ = try journal.load(conflict) }

    let credentials = UploadCredentials()
    var events: [(String, String)] = []
    credentials.emit = { events.append(($0, $1)) }
    let first = Task { try await credentials.request(operationId: "old-account") }
    while events.isEmpty { await Task.yield() }
    credentials.cancel(operationId: "old-account")
    credentials.resolve(requestId: events[0].0, token: "late-token")
    try await rejects(.cancelled) { _ = try await first.value }
    let second = Task { try await credentials.request(operationId: "new-account") }
    while events.count < 2 { await Task.yield() }
    try expect(events[0].0 != events[1].0, "Fresh credential request ID")
    credentials.resolve(requestId: events[0].0, token: "stale-token")
    credentials.resolve(requestId: events[1].0, token: "new-token")
    try expect(try await second.value == "new-token", "Late credential cannot retarget")
  }

  @MainActor private static func fixture() throws -> (UploadInput, UploadJournal, URL, FakeHTTP, UploadCredentials) {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let credentials = UploadCredentials()
    credentials.emit = { id, _ in credentials.resolve(requestId: id, token: "fresh-token") }
    return (try input(), UploadJournal(root: root), root, FakeHTTP(), credentials)
  }
  private static func json(_ body: [String: Any], status: Int = 200) throws -> UploadHTTPResponse {
    .init(status: status, body: try JSONSerialization.data(withJSONObject: body))
  }
  private static let sessionID = "22222222-2222-2222-2222-222222222222"
  private static func session(_ state: String = "staging", expiry: String = "2099-01-01T00:00:00Z") -> [String: Any] {
    let auth = Data(repeating: 1, count: 408)
    return ["profile": "encrypted_upload_v2", "session_id": sessionID, "owner_revision": 1,
      "policy": "v2_required", "authorization_base64": auth.base64EncodedString(),
      "authorization_sha256": UploadValidation.hash(auth), "expires_at": expiry, "state": state,
      "channel": "ble", "ciphertext_length": 512, "ciphertext_sha256": String(repeating: "a", count: 64)]
  }
  @MainActor private static func operation(_ input: UploadInput, _ journal: UploadJournal,
      _ http: FakeHTTP, _ credentials: UploadCredentials, nonceByte: UInt8 = 2) -> UploadOperation {
    UploadOperation(input: input, journal: journal, http: http, credentials: credentials,
      readNonce: { _ in Data(repeating: nonceByte, count: 16) }, wait: { _ in })
  }

  @MainActor private static func prepareAndResume() async throws {
    let (input, journal, root, http, credentials) = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    http.handler = { request in
      if request.url!.path.hasSuffix("/recordings") { return try json(["id": "rec_one"]) }
      return try json(session())
    }
    let op = operation(input, journal, http, credentials)
    let selected = try await op.prepare()
    try expect(selected.session.session_id == sessionID, "Selected server identity")
    try expect(http.requests.count == 2, "One initial create each")
    try expect(http.requests.allSatisfy { $0.value(forHTTPHeaderField: "X-Organization-Id") == "org_a" && $0.url!.path.hasPrefix("/v1/") }, "Retain dashboard tenant scope")
    let createdBody = try JSONSerialization.jsonObject(with: http.requests[0].httpBody!) as! [String: Any]
    try expect(createdBody["end_user_id"] as? String == "eu_a", "Retain exact EndUser")
    let saved = try journal.load(input)
    try expect(saved?.recordingId == "rec_one" && saved?.sessionId == sessionID, "Both create identities durable")
    let next = operation(input, UploadJournal(root: root), http, credentials)
    _ = try await next.prepare()
    try expect(http.requests.count == 3 && http.requests.last?.httpMethod == "GET", "Restart status avoids duplicate create")
    try await rejects(.state) { try op.complete() }
    try expect(try journal.load(input) != nil, "Early completion retains journal")

    var foreign = input
    foreign.priorJournalEntry = .init(recordingId: "rec_other", sessionId: nil, ownerRevision: nil)
    try await rejects(.identityConflict) { _ = try await operation(foreign, journal, http, credentials).prepare() }
    try expect(http.requests.count == 3, "Conflict makes no network calls")

    let unknownRoot = root.appendingPathComponent("unknown")
    let unknownJournal = UploadJournal(root: unknownRoot)
    http.handler = { _ in throw UploadFailure.transport }
    try await rejects(.transport) { _ = try await operation(input, unknownJournal, http, credentials).prepare() }
    let count = http.requests.count
    try await rejects(.pending) { _ = try await operation(input, UploadJournal(root: unknownRoot), http, credentials).prepare() }
    try expect(http.requests.count == count, "Ambiguous initial create is never reissued after restart")
  }

  @MainActor private static func nonceRecovery() async throws {
    let (input, journal, root, http, credentials) = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    http.handler = { request in
      if request.url!.path.hasSuffix("/recordings") { return try json(["id": "rec_one"]) }
      return try json(session())
    }
    let first = operation(input, journal, http, credentials)
    _ = try await first.prepare()
    first.cancel()
    let originalHash = UploadValidation.hash(Data(repeating: 2, count: 16))
    let nextHash = UploadValidation.hash(Data(repeating: 3, count: 16))
    try expect(try journal.authorizationNonceSHA256(input) == originalHash, "Initial nonce hash is durable")
    let child = "33333333-3333-3333-3333-333333333333"
    http.handler = { request in
      if request.url!.path.hasSuffix("/recover") {
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
        try expect(body["reason"] as? String == "nonce_changed" && body["owner_revision"] as? Int == 1,
          "Unexpired parent recovers only for changed nonce")
        try expect(body["auth_nonce_base64"] as? String == Data(repeating: 3, count: 16).base64EncodedString(),
          "Recovery uses current native nonce")
      }
      var result = session()
      if request.url!.path.hasSuffix("/recover") || request.url!.path.hasSuffix(child) {
        result["session_id"] = child
        result["owner_revision"] = 2
      }
      return try json(result)
    }
    let next = operation(input, journal, http, credentials, nonceByte: 3)
    let selected = try await next.prepare()
    try expect(selected.session.session_id == child, "Same recording receives successor")
    try expect(try journal.load(input)?.recordingId == "rec_one", "Cloud recording is preserved")
    try expect(try journal.authorizationNonceSHA256(input) == nextHash, "Successor nonce hash is durable")
    next.cancel()
    let restarted = operation(input, UploadJournal(root: root), http, credentials, nonceByte: 3)
    _ = try await restarted.prepare()
    restarted.cancel()
    try expect(http.requests.filter { $0.url!.path.hasSuffix("/recover") }.count == 1, "Unchanged nonce resumes without replacement")
    try expect(http.requests.filter { $0.httpMethod == "POST" && $0.url!.path.hasSuffix("/sessions") }.count == 1,
      "No duplicate initial session")
    let parent = UploadJournalEntry(recordingId: "rec_one", sessionId: sessionID, ownerRevision: 1)
    try journal.save(input, entry: parent, authorizationNonceSHA256: originalHash)
    http.handler = { request in
      if request.url!.path.hasSuffix("/recover") { return try json([:], status: 409) }
      return try json(session())
    }
    try await rejects(.http(409)) { _ = try await operation(input, journal, http, credentials, nonceByte: 3).prepare() }
    try expect(try journal.load(input) == parent && journal.authorizationNonceSHA256(input) == originalHash,
      "Rejected recovery retains original pointer and nonce")
    try expect(try journal.recoveryNonceBase64(input) == Data(repeating: 3, count: 16).base64EncodedString(),
      "Unsettled recovery retains exact request nonce")
    http.handler = { request in
      if request.url!.path.hasSuffix("/recover") { throw UploadFailure.transport }
      return try json(session("cancelled"))
    }
    try await rejects(.transport) { _ = try await operation(input, journal, http, credentials, nonceByte: 4).prepare() }
    let latest = "44444444-4444-4444-4444-444444444444"
    http.handler = { request in
      let path = request.url!.path
      var result = session(path.hasSuffix(sessionID) ? "cancelled" : "staging")
      if path.hasSuffix("/recover") {
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
        let nonce: UInt8 = path.contains(child) ? 4 : 3
        try expect(body["auth_nonce_base64"] as? String == Data(repeating: nonce, count: 16).base64EncodedString(),
          "Lost response retries original nonce before recovering stale child")
      }
      if path.hasSuffix(latest) || path.hasSuffix(child + "/recover") {
        result["session_id"] = latest; result["owner_revision"] = 3
      } else if path.hasSuffix(child) || path.hasSuffix(sessionID + "/recover") {
        result["session_id"] = child; result["owner_revision"] = 2
      }
      return try json(result)
    }
    let reconciled = operation(input, UploadJournal(root: root), http, credentials, nonceByte: 4)
    try expect(try await reconciled.prepare().session.session_id == latest, "Lost response and new nonce follow bounded successor chain")
    reconciled.cancel()
    try expect(try journal.recoveryNonceBase64(input) == nil, "Success clears pending request nonce")
    for state in ["ready", "processing", "published", "staging"] {
      // A separate journal creates the legacy fixture without inheriting nonce metadata.
      let oldRoot = root.appendingPathComponent(state)
      let oldJournal = UploadJournal(root: oldRoot)
      try oldJournal.save(input, entry: parent, authorizationNonceSHA256: state == "staging" ? nil : originalHash)
      http.handler = { _ in try json(session(state)) }
      let count = http.requests.count
      let op = operation(input, oldJournal, http, credentials, nonceByte: 3)
      _ = try await op.prepare()
      op.cancel()
      try expect(http.requests.count == count + 1 && http.requests.last?.httpMethod == "GET",
        "Post-manifest and legacy no-nonce sessions never recover on nonce change")
    }
  }

  @MainActor private static func reconnectJournalIdentity() async throws {
    let (original, journal, root, http, credentials) = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let entry = UploadJournalEntry(recordingId: "rec_one", sessionId: sessionID, ownerRevision: 1)
    try journal.save(original, entry: entry)
    var rotated = original
    rotated.scope.nativeDeviceId = "native-b"
    http.handler = { _ in try json(session()) }
    _ = try await operation(rotated, UploadJournal(root: root), http, credentials).prepare()
    try expect(http.requests.count == 1 && http.requests[0].httpMethod == "GET", "Address rotation resumes existing session")
    for field in ["account", "project", "organization", "environment", "endUser", "origin", "serial", "binding", "duration", "plaintext"] {
      var changed = rotated
      switch field {
      case "account": changed.scope.accountId = "account-b"
      case "project": changed.scope.projectId = "project_b"
      case "organization": changed.scope.organizationId = "org_b"
      case "environment": changed.scope.environment = "development"
      case "endUser": changed.scope.endUserId = "eu_b"
      case "origin": changed.scope.apiOrigin = "https://other.example.test"
      case "serial": changed.scope.serialNumber = "BOTA999"
      case "binding": changed.scope.bindingGeneration = 2
      case "duration": changed.recording.durationMs = "2000"
      default: changed.recording.plaintextLength = "257"
      }
      try await rejects(.identityConflict) { _ = try await operation(changed, journal, http, credentials).prepare() }
    }
    try expect(http.requests.count == 1, "Stable identity conflicts never dispatch HTTP")
    let file = root.appendingPathComponent(original.journalKey + ".json")
    for phase in ["ready", "recording_create_unknown", "session_create_unknown"] {
      var legacy: [String: Any] = ["version": 1, "identity": try original.identity(includeTransport: true),
        "phase": phase, "importedPriorSHA256": String(repeating: "a", count: 64)]
      if phase != "recording_create_unknown" { legacy["entry"] = ["recordingId": "rec_one"] }
      let data = try JSONSerialization.data(withJSONObject: legacy)
      try data.write(to: file)
      try await rejects(.identityConflict) { _ = try journal.load(rotated) }
      try expect(try Data(contentsOf: file) == data, "Unmatched legacy journal is retained")
      if phase == "ready" { _ = try journal.load(original) }
      else { try await rejects(.pending) { _ = try journal.load(original) } }
      let migrated = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
      try expect(migrated["version"] as? Int == 2 && migrated["phase"] as? String == phase,
        "Legacy migration preserves phase")
      try expect(migrated["importedPriorSHA256"] as? String == String(repeating: "a", count: 64), "Imported identity preserved")
      if phase == "ready" { try expect(try journal.load(rotated)?.recordingId == "rec_one", "Migrated recording survives rotation") }
      else { try await rejects(.pending) { _ = try journal.load(rotated) } }
    }
  }

  @MainActor private static func createRejectionRollback() async throws {
    for boundary in ["recordings", "sessions"] {
      for status in [401, 403] {
        for importPrior in [false, true] {
          let (initial, journal, root, http, credentials) = try fixture()
          defer { try? FileManager.default.removeItem(at: root) }
          var value = initial
          let recording = UploadJournalEntry(recordingId: "rec_one")
          let file = root.appendingPathComponent(value.journalKey + ".json")
          var before: NSDictionary?
          if boundary == "sessions" {
            value.priorJournalEntry = recording
            try journal.save(value, entry: recording)
            before = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? NSDictionary
            if !importPrior { value.priorJournalEntry = nil }
          }
          var events: [String] = []
          credentials.emit = { id, _ in
            events.append(id)
            credentials.resolve(requestId: id, token: "token-\(events.count)")
          }
          http.handler = { request in
            try expect(request.url!.path.hasSuffix("/" + boundary), "Only the denied create is dispatched")
            return try json([:], status: status)
          }
          try await rejects(.http(status)) { _ = try await operation(value, journal, http, credentials).prepare() }
          try expect(http.requests.count == 1, "Denied initial create is not automatically retried")
          let restored = try UploadJournal(root: root).load(value)
          try expect(restored == (boundary == "sessions" ? recording : nil), "Denied create restores pre-call journal")
          if let before {
            let after = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? NSDictionary
            try expect(before == after, "Session rollback retains full identity and original imported digest")
            var foreign = value
            foreign.scope.accountId = "account-b"
            try await rejects(.identityConflict) { _ = try journal.load(foreign) }
            foreign = value
            foreign.priorJournalEntry = .init(recordingId: "rec_other")
            try await rejects(.identityConflict) { _ = try journal.load(foreign) }
          }
          value.operationId = "operation-retry"
          http.handler = { request in
            if request.url!.path.hasSuffix("/recordings") { return try json(["id": "rec_one"]) }
            return try json(session())
          }
          _ = try await operation(value, UploadJournal(root: root), http, credentials).prepare()
          try expect(try journal.load(value)?.sessionId == sessionID, "Explicit fresh-auth retry commits session")
          try expect(events.count == http.requests.count && Set(events).count == events.count, "Each attempt gets fresh credentials")
          for (index, request) in http.requests.enumerated() {
            try expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token-\(index + 1)", "Retry uses its own credential")
            try expect(request.url!.host == "api.example.test" && request.url!.path.hasPrefix("/v1/recordings") &&
              request.value(forHTTPHeaderField: "X-Organization-Id") == "org_a", "Retry retains captured dashboard scope")
          }
        }
      }
    }
  }

  @MainActor private static func uncertainCreateRetention() async throws {
    for boundary in ["recordings", "sessions"] {
      for failure in [UploadFailure.transport, .http(401), .http(403), .http(429), .http(500), .http(503)] {
        let (value, journal, root, http, credentials) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        if boundary == "sessions" { try journal.save(value, entry: .init(recordingId: "rec_one")) }
        http.handler = { _ in
          if case .http(let status) = failure, status != 401 && status != 403 { return try json([:], status: status) }
          throw failure
        }
        try await rejects(failure) { _ = try await operation(value, journal, http, credentials).prepare() }
        try await rejects(.pending) { _ = try await operation(value, UploadJournal(root: root), http, credentials).prepare() }
        try expect(http.requests.count == 1, "Transport, thrown auth error and uncertain HTTP keep unknown without retry")
      }
      for status in [401, 403] {
        for cancelTask in [false, true] {
          let (value, journal, root, http, credentials) = try fixture()
          defer { try? FileManager.default.removeItem(at: root) }
          if boundary == "sessions" { try journal.save(value, entry: .init(recordingId: "rec_one")) }
          var held: CheckedContinuation<UploadHTTPResponse, Error>?
          http.handler = { _ in try await withCheckedThrowingContinuation { held = $0 } }
          let op = operation(value, journal, http, credentials)
          let running = Task { try await op.prepare() }
          while held == nil { await Task.yield() }
          let file = root.appendingPathComponent(value.journalKey + ".json")
          let before = try Data(contentsOf: file)
          if cancelTask { running.cancel() } else { op.cancel() }
          held!.resume(returning: try json([:], status: status))
          try await rejects(.cancelled) { _ = try await running.value }
          try expect(try Data(contentsOf: file) == before, "Cancelled auth response retains the exact unknown marker")
          try await rejects(.pending) { _ = try await operation(value, UploadJournal(root: root), http, credentials).prepare() }
          try expect(http.requests.count == 1, "Cancelled create cannot be reissued after restart")
        }
      }
    }
  }

  @MainActor private static func rollbackGuardsAndDurability() async throws {
    for boundary in ["recordings", "sessions"] {
      let (value, journal, root, _, _) = try fixture()
      defer { try? FileManager.default.removeItem(at: root) }
      let entry: UploadJournalEntry? = boundary == "sessions" ? .init(recordingId: "rec_one") : nil
      let file = root.appendingPathComponent(value.journalKey + ".json")
      try journal.markUnknown(value, entry: entry)
      let original = try Data(contentsOf: file)
      var foreign = value
      foreign.scope.accountId = "account-b"
      try await rejects(.identityConflict) { try journal.rollbackRejectedCreate(foreign, entry: entry) }
      try expect(try Data(contentsOf: file) == original, "Rollback cannot cross the original scope")

      try journal.markUnknown(value, entry: .init(recordingId: "rec_other"))
      let changed = try Data(contentsOf: file)
      try await rejects(.identityConflict) { try journal.rollbackRejectedCreate(value, entry: entry) }
      try expect(try Data(contentsOf: file) == changed, "Rollback cannot replace another pending create")

      let committed = UploadJournalEntry(recordingId: "rec_one", sessionId: sessionID, ownerRevision: 1)
      try journal.save(value, entry: committed)
      try await rejects(.identityConflict) { try journal.rollbackRejectedCreate(value, entry: entry) }
      try expect(try journal.load(value) == committed, "Rollback cannot discard a committed session")

      try journal.markUnknown(value, entry: entry)
      var hitFailure = false
      let failing = UploadJournal(root: root, synchronize: { fd in
        var info = stat()
        guard fstat(fd, &info) == 0 else { return -1 }
        let rejectFile = boundary == "sessions" && info.st_mode & S_IFMT == S_IFREG
        let rejectRemoval = boundary == "recordings" && !FileManager.default.fileExists(atPath: file.path)
        if rejectFile || rejectRemoval { hitFailure = true; return -1 }
        return fsync(fd)
      })
      try await rejects(.journal) { try failing.rollbackRejectedCreate(value, entry: entry) }
      try expect(hitFailure, "Rollback must synchronize its restored file or removed directory entry")
      if boundary == "sessions" {
        try await rejects(.pending) { _ = try UploadJournal(root: root).load(value) }
      } else {
        try expect(!FileManager.default.fileExists(atPath: file.path), "Post-unlink sync failure is reported without inventing an entry")
      }
    }
  }

  @MainActor private static func cancellationDrain() async throws {
    for boundary in ["recordings", "sessions", "recover"] {
      let (input, journal, root, http, credentials) = try fixture()
      defer { try? FileManager.default.removeItem(at: root) }
      if boundary == "recover" {
        try journal.save(input, entry: .init(recordingId: "rec_one", sessionId: sessionID, ownerRevision: 1))
      }
      let op = operation(input, journal, http, credentials)
      var held: CheckedContinuation<UploadHTTPResponse, Error>?
      http.handler = { request in
        if request.url!.path.hasSuffix("/" + boundary) {
          return try await withCheckedThrowingContinuation { held = $0 }
        }
        if request.url!.path.hasSuffix("/recordings") { return try json(["id": "rec_one"]) }
        return try json(session("expired"))
      }
      let running = Task { try await op.prepare() }
      while held == nil { await Task.yield() }
      op.cancel()
      if boundary == "recordings" { held!.resume(returning: try json(["id": "rec_one"])) }
      else if boundary == "sessions" { held!.resume(returning: try json(session())) }
      else { held!.resume(returning: try json(["profile": "encrypted_upload_v2",
        "session_id": "33333333-3333-3333-3333-333333333333", "owner_revision": 2])) }
      try await rejects(.cancelled) { _ = try await running.value }
      let saved = try UploadJournal(root: root).load(input)
      try expect(saved?.recordingId == "rec_one", "Cancelled committed create drains into original journal")
      if boundary == "sessions" { try expect(saved?.sessionId == sessionID, "Session response drains") }
      if boundary == "recover" { try expect(saved?.ownerRevision == 2, "Replacement response drains") }
      if boundary != "recordings" {
        try expect(try journal.authorizationNonceSHA256(input) == UploadValidation.hash(Data(repeating: 2, count: 16)),
          "Cancellation drains nonce hash with committed session pointer")
      }
    }
  }

  @MainActor private static func manifestReconciliation() async throws {
    let (input, journal, root, http, credentials) = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    try journal.save(input, entry: .init(recordingId: "rec_one", sessionId: sessionID, ownerRevision: 1))
    http.handler = { _ in try json(session("staging")) }
    let op = operation(input, journal, http, credentials)
    _ = try await op.prepare()
    let manifest = Data(repeating: 4, count: 580)
    let evidence = UploadEvidence(ciphertextLength: 512, ciphertextSHA256: Data(repeating: 0xaa, count: 32),
      manifestLength: 580, manifestSHA256: Data(SHA256.hash(data: manifest)))
    for status in [403, 409, 503] {
      http.handler = { _ in try json(["error": ["code": "resource_already_exists"]], status: status) }
      try await rejects(.http(status)) { _ = try await op.reconcileStaging(manifest, evidence: evidence) }
    }
    http.handler = { _ in try json(["error": ["code": "encrypted_upload_v2_staging_missing"]], status: 403) }
    try await rejects(.http(403)) { _ = try await op.reconcileStaging(manifest, evidence: evidence) }
    http.handler = { _ in try json(["error": ["code": "encrypted_upload_v2_staging_missing"]], status: 409) }
    try expect(try await op.reconcileStaging(manifest, evidence: evidence), "Exact missing permits PUT")
    http.handler = { _ in try json([:], status: 202) }
    try expect(try await !op.reconcileStaging(manifest, evidence: evidence), "Accepted manifest avoids duplicate PUT")
    let count = http.requests.count
    try await op.submitManifest(manifest, evidence: evidence)
    try expect(http.requests.count == count, "Accepted manifest is not resubmitted")
    op.cancel()
    http.handler = { _ in try json(session("processing")) }
    let resumed = try await operation(input, UploadJournal(root: root), http, credentials).prepare()
    try expect(resumed.recordingId == "rec_one" && resumed.session.session_id == sessionID,
      "Restart retains accepted cloud identity")
    var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as! [String: Any]
    object["journalKey"] = nil
    let derived = try UploadInput.decode(JSONSerialization.data(withJSONObject: object))
    try expect(derived.journalKey == input.journalKey, "Native key matches old exact identity")
  }

  @MainActor private static func documentsAndExpiry() async throws {
    let (input, journal, root, http, credentials) = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    try journal.save(input, entry: .init(recordingId: "rec_one", sessionId: sessionID, ownerRevision: 1))
    let evidence = UploadEvidence(ciphertextLength: 512, ciphertextSHA256: Data(repeating: 0xaa, count: 32),
      manifestLength: 580, manifestSHA256: Data(SHA256.hash(data: Data(repeating: 4, count: 580))))
    for state in ["staged", "ready", "processing", "published"] {
      http.handler = { _ in try json(session(state)) }
      let op = operation(input, journal, http, credentials)
      _ = try await op.prepare()
      try expect(try op.shouldUpload(evidence) == false, "Staged and later skip PUT")
      let count = http.requests.count
      try await op.submitManifest(Data(repeating: 4, count: 580), evidence: evidence)
      try expect(http.requests.count == count + (state == "staged" ? 1 : 0), "Manifest resumes only before accepted")
    }
    for state in ["created", "failed", "cancelled", "unknown"] {
      http.handler = { _ in try json(session(state)) }
      try await rejects(.state) { _ = try await operation(input, journal, http, credentials).prepare() }
    }
    http.handler = { _ in
      var value = session(); value["authorization_sha256"] = String(repeating: "0", count: 64)
      return try json(value)
    }
    try await rejects(.invalidDocument) { _ = try await operation(input, journal, http, credentials).prepare() }
    http.handler = { _ in try json(session()) }
    let op = operation(input, journal, http, credentials)
    _ = try await op.prepare()
    try await rejects(.invalidDocument) { try await op.submitManifest(Data(repeating: 4, count: 579), evidence: evidence) }
    http.handler = { _ in
      var value = session("published")
      value["plaintext_length"] = 256
      let receipt = Data(repeating: 3, count: 336)
      value["completion_receipt_base64"] = receipt.base64EncodedString()
      value["completion_receipt_sha256"] = UploadValidation.hash(receipt)
      return try json(value)
    }
    try await op.finalize(evidence)
    try expect(try op.completionReceipt(evidence).count == 336, "Published receipt accepted")
    try expect(try journal.load(input) != nil, "Receipt alone never removes journal")
    try op.complete()
    try expect(try journal.load(input) == nil, "Explicit SDK success removes journal")
  }

  @MainActor private static func contextsAndBounds() async throws {
    let (input, journal, root, http, credentials) = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let op = operation(input, journal, http, credentials)
    let contextID = "44444444-4444-4444-4444-444444444444"
    let challenge = Data(repeating: 5, count: 196).base64EncodedString()
    func context(_ state: String) -> [String: Any] {
      ["context_id": contextID, "challenge_base64": challenge, "state": state,
       "expires_at": "2099-01-01T00:00:00Z", "result_base64": NSNull()]
    }
    var creates = 0
    var proofs = 0
    var polls = 0
    var events = 0
    credentials.emit = { id, operationId in
      if operationId == input.operationId { events += 1 }
      credentials.resolve(requestId: id, token: "fresh-\(events)")
    }
    http.handler = { request in
      if request.url!.path.hasSuffix("/contexts") {
        creates += 1
        if creates < 3 { return try json([:], status: 503) }
        return try json(context("challenge"))
      }
      if request.url!.path.hasSuffix("/proof") {
        proofs += 1
        if proofs == 1 { throw UploadFailure.transport }
        return try json(context("pending"))
      }
      polls += 1
      var result = context(polls == 100 ? "complete" : "pending")
      if polls == 100 { result["result_base64"] = Data(repeating: 6, count: 264).base64EncodedString() }
      return try json(result)
    }
    let exchange = try await op.uploadContext(Data(repeating: 7, count: 16))
    try expect(exchange.challenge.count == 196, "Exact challenge length")
    let result = try await exchange.exchangeProof(Data(repeating: 8, count: 116))
    try expect(result.count == 264 && creates == 3 && proofs == 2 && polls == 100, "Bounded retries and final poll accepted")
    try expect(events == http.requests.count, "Every retry and poll requests fresh credential")
    try expect(http.requests[0].httpBody == http.requests[1].httpBody && http.requests[1].httpBody == http.requests[2].httpBody,
      "Retries reuse context nonce")
    try expect(http.requests[3].httpBody == http.requests[4].httpBody, "Proof retry uses identical bytes")
    for final in ["wrong-id", "missing-result", "pending-result"] {
      polls = 0
      http.handler = { request in
        if request.url!.path.hasSuffix("/proof") { return try json(context("pending")) }
        polls += 1
        var value = context("pending")
        if polls == 100 {
          if final == "wrong-id" { value["context_id"] = sessionID }
          if final == "missing-result" { value["state"] = "complete" }
          if final == "pending-result" { value["result_base64"] = "opaque" }
        }
        return try json(value)
      }
      try await rejects(.invalidDocument) { _ = try await exchange.exchangeProof(Data(repeating: 8, count: 116)) }
      try expect(polls == 100, "Last allowed context response validated")
    }
    http.handler = { _ in try json([:], status: 403) }
    let count = http.requests.count
    try await rejects(.http(403)) { _ = try await op.uploadContext(Data(repeating: 7, count: 16)) }
    try expect(http.requests.count == count + 1, "Permission denial has no retry")
    try await rejects(.invalidDocument) { _ = try await exchange.exchangeProof(Data(repeating: 8, count: 115)) }
  }

  private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_700_000_000)
    func now() -> Date { lock.withLock { current } }
    func expire() { lock.withLock { current = Date(timeIntervalSince1970: 4_100_000_000) } }
  }

  @MainActor private static func stagingAndDurability() async throws {
    let (input, journal, root, http, credentials) = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let entry = UploadJournalEntry(recordingId: "rec_one", sessionId: sessionID, ownerRevision: 1)
    try journal.save(input, entry: entry)
    let evidence = UploadEvidence(ciphertextLength: 512, ciphertextSHA256: Data(repeating: 0xaa, count: 32),
      manifestLength: 580, manifestSHA256: Data(repeating: 0, count: 32))
    for expireDuringRefresh in [false, true] {
      let clock = Clock()
      let op = UploadOperation(input: input, journal: journal, http: http, credentials: credentials,
        readNonce: { _ in Data(repeating: 0, count: 16) }, wait: { _ in }, now: { clock.now() })
      http.handler = { _ in try json(session()) }
      _ = try await op.prepare()
      http.handler = { request in
        try expect(request.url!.path.hasSuffix("/staging-url"), "Fresh target fetched immediately before native PUT")
        if expireDuringRefresh { clock.expire() }
        return try json(["url": "https://staging.example.test/fresh?signature=private",
          "method": "PUT", "headers": ["x-amz-checksum-sha256": "checksum", "Content-Type": "application/octet-stream"]])
      }
      if expireDuringRefresh {
        try await rejects(.expired) { _ = try await op.stagingRequest(evidence) }
      } else {
        let request = try await op.stagingRequest(evidence)
        try expect(request.httpMethod == "PUT" && request.httpBody == nil, "SDK gets bodyless PUT")
        try expect(request.value(forHTTPHeaderField: "Authorization") == nil, "Cognito never goes to staging")
        try expect(request.value(forHTTPHeaderField: "x-amz-checksum-sha256") == "checksum", "Presigned headers retained")
        clock.expire()
        let count = http.requests.count
        try await rejects(.expired) { _ = try await op.stagingRequest(evidence) }
        try expect(http.requests.count == count, "Elapsed authorization never fetches target")
      }
      try expect(try journal.load(input) == entry, "Expiry retains journal")
    }

    let failing = UploadJournal(root: root, synchronize: { fd in
      var info = stat()
      if fstat(fd, &info) == 0 && info.st_mode & S_IFMT == S_IFREG { return -1 }
      return fsync(fd)
    })
    let successor = UploadJournalEntry(recordingId: "rec_one", sessionId: "33333333-3333-3333-3333-333333333333", ownerRevision: 2)
    try await rejects(.journal) { try failing.save(input, entry: successor) }
    try expect(try journal.load(input) == entry, "Failed file sync retains old committed journal")
    var fileSynced = false
    let failingDirectory = UploadJournal(root: root, synchronize: { fd in
      var info = stat()
      if fstat(fd, &info) == 0 && info.st_mode & S_IFMT == S_IFREG { fileSynced = true }
      else if fileSynced { return -1 }
      return fsync(fd)
    })
    try await rejects(.journal) { try failingDirectory.save(input, entry: successor) }
    try expect(try journal.load(input) == successor, "Rename-before-directory-sync uncertainty preserves newest identity")
    let path = root.appendingPathComponent(input.journalKey + ".json")
    try Data("corrupt".utf8).write(to: path)
    try await rejects(.journal) { _ = try journal.load(input) }
    try FileManager.default.removeItem(at: path)
    try FileManager.default.createSymbolicLink(at: path, withDestinationURL: root.appendingPathComponent("absent"))
    try await rejects(.journal) { _ = try journal.load(input) }
  }

  @MainActor private static func coordinatorLifetime() async throws {
    let (input, journal, root, http, credentials) = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    var registrations = 0
    var removed: [String] = []
    let coordinator = UploadCoordinator(credentials: credentials,
      makeOperation: { operation($0, journal, http, credentials) },
      register: { _, _ in registrations += 1; return "opaque-registration" }, unregister: { removed.append($0) })
    http.handler = { request in
      request.url!.path.hasSuffix("/recordings") ? try json(["id": "rec_one"]) : try json(session())
    }
    let selected = try await coordinator.prepare(input)
    let result = selected.dictionary
    try expect(Set(result.keys) == ["profile", "uploadSessionId", "ownerRevision", "securityPolicy", "materialRegistrationId", "recordingId"],
      "JS decision whitelists only public scalar metadata")
    coordinator.cancel(input.operationId)
    try expect(registrations == 1 && removed == ["opaque-registration"], "Cancel removes unused native registration")
    try await rejects(.cancelled) { _ = try await coordinator.prepare(input) }
    try expect(try journal.load(input)?.sessionId == sessionID, "Cancellation keeps durable session")
    var before = input
    before.operationId = "cancel-before-prepare"
    coordinator.cancel(before.operationId)
    try await rejects(.cancelled) { _ = try await coordinator.prepare(before) }
  }

  @MainActor private static func recoveryAndCancellationBounds() async throws {
    let (input, journal, root, http, credentials) = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let entry = UploadJournalEntry(recordingId: "rec_one", sessionId: sessionID, ownerRevision: 1)
    try journal.save(input, entry: entry)
    var revision = 1
    var id = sessionID
    var recoveries = 0
    http.handler = { request in
      if request.url!.path.hasSuffix("/recover") {
        recoveries += 1
        revision += 1
        id = String(repeating: String(revision + 4), count: 8) + "-2222-2222-2222-222222222222"
        return try json(["profile": "encrypted_upload_v2", "session_id": id, "owner_revision": revision])
      }
      var status = session("expired")
      status["session_id"] = id
      status["owner_revision"] = revision
      return try json(status)
    }
    try await rejects(.expired) { _ = try await operation(input, journal, http, credentials).prepare() }
    try expect(recoveries == 3 && revision == 4, "At most three signed successor hops")
    try expect(try journal.load(input)?.ownerRevision == 4, "Final successor remains durable at traversal limit")
    try journal.save(input, entry: entry)
    http.handler = { _ in
      var status = session(); status["ciphertext_length"] = 513
      return try json(status)
    }
    try await rejects(.identityConflict) { _ = try await operation(input, journal, http, credentials).prepare() }

    var checkpoint = input
    checkpoint.checkpoint = .init(version: 1, uploadSessionId: sessionID, ownerRevision: 2,
      revision: 1, nextCiphertextOffset: "0", prefixSha256: String(repeating: "0", count: 64),
      transportSessionId: "1", sinkRegistrationId: "opaque-sink", windowPackets: 1, dataPayloadBytes: 128)
    let calls = http.requests.count
    try await rejects(.identityConflict) { _ = try await operation(checkpoint, journal, http, credentials).prepare() }
    checkpoint.checkpoint?.ownerRevision = 1
    checkpoint.checkpoint?.nextCiphertextOffset = "513"
    try await rejects(.identityConflict) { _ = try await operation(checkpoint, journal, http, credentials).prepare() }
    try expect(http.requests.count == calls, "Invalid checkpoint rejected before HTTP")

    var started = false
    var stopped = false
    http.handler = { _ in
      started = true
      do { try await Task.sleep(nanoseconds: 60_000_000_000) }
      catch { stopped = true; throw error }
      throw TestFailure(label: "Ordinary HTTP failed to cancel")
    }
    let op = operation(input, journal, http, credentials)
    let pending = Task { try await op.prepare() }
    while !started { await Task.yield() }
    op.cancel()
    try await rejects(.cancelled) { _ = try await pending.value }
    try expect(stopped, "Ordinary status HTTP aborted")
    try expect(try journal.load(input) == entry, "HTTP cancellation preserves recovery identity")

    var events: [String] = []
    credentials.emit = { id, _ in events.append(id) }
    let waiting = operation(input, journal, http, credentials)
    let prepare = Task { try await waiting.prepare() }
    while events.isEmpty { await Task.yield() }
    let count = http.requests.count
    waiting.cancel()
    credentials.resolve(requestId: events[0], token: "late-account-token")
    try await rejects(.cancelled) { _ = try await prepare.value }
    try expect(http.requests.count == count, "Cancelled credentials never dispatch HTTP")
  }

  @MainActor private static func importedPriorSurvivesRecovery() async throws {
    let (original, journal, root, http, credentials) = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    var input = original
    input.priorJournalEntry = .init(recordingId: "rec_one", sessionId: sessionID, ownerRevision: 1)
    let child = "33333333-3333-3333-3333-333333333333"
    var recovering: CheckedContinuation<UploadHTTPResponse, Error>?
    http.handler = { request in
      if request.url!.path.hasSuffix("/recover") {
        return try await withCheckedThrowingContinuation { recovering = $0 }
      }
      return try json(session("expired"))
    }
    let op = operation(input, journal, http, credentials)
    let prepare = Task { try await op.prepare() }
    while recovering == nil { await Task.yield() }
    op.cancel()
    recovering!.resume(returning: try json(["profile": "encrypted_upload_v2", "session_id": child, "owner_revision": 2]))
    try await rejects(.cancelled) { _ = try await prepare.value }
    http.handler = { _ in
      var status = session()
      status["session_id"] = child
      status["owner_revision"] = 2
      return try json(status)
    }
    let resumed = try await operation(input, UploadJournal(root: root), http, credentials).prepare()
    try expect(resumed.session.owner_revision == 2, "Original imported legacy pointer admits committed successor after cancellation")
    var missingPrior = input
    missingPrior.priorJournalEntry = nil
    _ = try await operation(missingPrior, UploadJournal(root: root), http, credentials).prepare()
    _ = try await operation(input, UploadJournal(root: root), http, credentials).prepare()
    input.priorJournalEntry?.sessionId = "55555555-5555-5555-5555-555555555555"
    try await rejects(.identityConflict) { _ = try await operation(input, journal, http, credentials).prepare() }
  }

  @MainActor private static func invalidInputsAndReceipts() async throws {
    let (input, journal, root, http, credentials) = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    for bad in ["..", "production\n", "proj/a"] {
      var invalid = input
      invalid.scope.environment = bad
      try await rejects(.invalidInput) { try invalid.validate() }
    }
    var oversized = input
    oversized.recording.ciphertextLength = "9007199254740992"
    try await rejects(.invalidInput) { try oversized.validate() }
    try journal.save(input, entry: .init(recordingId: "rec_one", sessionId: sessionID, ownerRevision: 1))
    let evidence = UploadEvidence(ciphertextLength: 512, ciphertextSHA256: Data(repeating: 0xaa, count: 32),
      manifestLength: 580, manifestSHA256: Data(repeating: 0, count: 32))
    for bad in ["plaintext", "length", "hash", "base64"] {
      http.handler = { _ in try json(session("ready")) }
      let op = operation(input, journal, http, credentials)
      _ = try await op.prepare()
      http.handler = { _ in
        var status = session("published")
        status["plaintext_length"] = bad == "plaintext" ? 255 : 256
        let data = Data(repeating: 3, count: bad == "length" ? 335 : 336)
        status["completion_receipt_base64"] = data.base64EncodedString() + (bad == "base64" ? "\n" : "")
        status["completion_receipt_sha256"] = bad == "hash" ? String(repeating: "0", count: 64) : UploadValidation.hash(data)
        return try json(status)
      }
      try await rejects(.invalidDocument) { try await op.finalize(evidence) }
      try await rejects(.state) { try op.complete() }
    }
    http.handler = { _ in try json(session("ready")) }
    let op = operation(input, journal, http, credentials)
    _ = try await op.prepare()
    let count = http.requests.count
    try await rejects(.pending) { try await op.finalize(evidence) }
    try expect(http.requests.count == count + 60, "Publication polling is bounded")

    let failing = UploadJournal(root: root.appendingPathComponent("no-sync"), synchronize: { _ in -1 })
    let calls = http.requests.count
    try await rejects(.journal) { _ = try await operation(input, failing, http, credentials).prepare() }
    try expect(http.requests.count == calls, "No create before journal durability succeeds")
  }
}
