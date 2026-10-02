import Foundation

struct UploadSelection: Sendable {
  let profile = "encrypted_upload_v2"
  let uploadSessionId: String
  let ownerRevision: UInt32
  let securityPolicy: String
  let materialRegistrationId: String
  let recordingId: String

  var dictionary: [String: Any] {
    ["profile": profile, "uploadSessionId": uploadSessionId, "ownerRevision": ownerRevision,
     "securityPolicy": securityPolicy, "materialRegistrationId": materialRegistrationId, "recordingId": recordingId]
  }
}

@MainActor final class UploadCoordinator {
  private struct Slot {
    let operation: UploadOperation
    var registrationId: String?
    var preparing: Bool = true
  }
  let credentials: UploadCredentials
  private let makeOperation: (UploadInput) -> UploadOperation
  private let register: (UploadOperation, UploadPrepared) throws -> String
  private let unregister: (String) -> Void
  private var slots: [String: Slot] = [:]
  private var usedIDs = Set<String>()

  init(credentials: UploadCredentials, makeOperation: @escaping (UploadInput) -> UploadOperation,
       register: @escaping (UploadOperation, UploadPrepared) throws -> String,
       unregister: @escaping (String) -> Void) {
    self.credentials = credentials
    self.makeOperation = makeOperation
    self.register = register
    self.unregister = unregister
  }

  func prepare(_ input: UploadInput) async throws -> UploadSelection {
    try input.validate()
    guard !usedIDs.contains(input.operationId) else { throw UploadFailure.cancelled }
    guard !slots.values.contains(where: { $0.operation.input.journalKey == input.journalKey }) else {
      throw UploadFailure.state
    }
    usedIDs.insert(input.operationId)
    let operation = makeOperation(input)
    slots[input.operationId] = Slot(operation: operation)
    do {
      let prepared = try await operation.prepare()
      try operation.check()
      let id = try register(operation, prepared)
      slots[input.operationId]?.registrationId = id
      slots[input.operationId]?.preparing = false
      return UploadSelection(uploadSessionId: prepared.session.session_id, ownerRevision: prepared.session.owner_revision,
        securityPolicy: prepared.session.policy, materialRegistrationId: id, recordingId: prepared.recordingId)
    } catch {
      operation.cancel()
      remove(input.operationId)
      throw UploadFailure.safe(error)
    }
  }

  func cancel(_ operationId: String) {
    usedIDs.insert(operationId)
    guard let slot = slots[operationId] else { return }
    slot.operation.cancel()
    // A preparing operation retains its journal lease until committed responses drain.
    if !slot.preparing { remove(operationId) }
  }

  func complete(_ operationId: String) throws {
    guard let slot = slots[operationId], !slot.preparing else { throw UploadFailure.state }
    try slot.operation.complete()
    remove(operationId)
  }

  func cancelAll() {
    for id in Array(slots.keys) { cancel(id) }
  }

  private func remove(_ operationId: String) {
    if let id = slots.removeValue(forKey: operationId)?.registrationId { unregister(id) }
  }
}
