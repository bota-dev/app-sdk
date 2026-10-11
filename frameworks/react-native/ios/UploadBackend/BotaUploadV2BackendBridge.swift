import BotaAppSDK
import Foundation

@objc(BotaUploadV2BackendBridge)
public final class BotaUploadV2BackendBridge: NSObject, @unchecked Sendable {
  @MainActor private var coordinator: UploadCoordinator?
  @MainActor private var destroyed = false
  @MainActor private var statusJobs: [String: Task<Void, Never>] = [:]
  @MainActor private var credentialsRequested: (@Sendable (String, String) -> Void)?

  @objc(readProtectedStreamingStatus:inputJSON:completion:)
  public func readProtectedStreamingStatus(_ id: String, inputJSON: String,
    completion: @escaping @Sendable (String?, NSError?) -> Void) {
    Task { @MainActor in
      guard !destroyed, statusJobs[id] == nil else { completion(nil, UploadFailure.cancelled as NSError); return }
      statusJobs[id] = Task { @MainActor in
        defer { statusJobs[id] = nil }
        do { let result = try await UploadStreamingStatus().read(inputJSON); completion(result, nil) }
        catch { completion(nil, UploadFailure.safe(error) as NSError) }
      }
    }
  }
  @objc(cancelProtectedStreamingStatus:completion:)
  public func cancelProtectedStreamingStatus(_ id: String, completion: @escaping @Sendable () -> Void) {
    Task { @MainActor in statusJobs[id]?.cancel(); completion() }
  }

  @objc(prepare:credentialsRequested:completion:)
  public func prepare(_ json: String,
    credentialsRequested: @escaping @Sendable (String, String) -> Void,
    completion: @escaping @Sendable (String?, NSError?) -> Void) {
    Task { @MainActor in
      do {
        guard !destroyed else { throw UploadFailure.cancelled }
        self.credentialsRequested = credentialsRequested
        let input = try UploadInput.decode(Data(json.utf8))
        let result = try await service().prepare(input)
        let data = try JSONSerialization.data(withJSONObject: result.dictionary)
        completion(String(decoding: data, as: UTF8.self), nil)
      } catch { completion(nil, UploadFailure.safe(error) as NSError) }
    }
  }

  @objc(cancel:completion:)
  public func cancel(_ id: String, completion: @escaping @Sendable () -> Void) {
    Task { @MainActor in coordinator?.cancel(id); completion() }
  }
  @objc(complete:completion:)
  public func complete(_ id: String, completion: @escaping @Sendable (NSError?) -> Void) {
    Task { @MainActor in
      do {
        guard !destroyed, let coordinator else { throw UploadFailure.cancelled }
        try coordinator.complete(id); completion(nil)
      } catch { completion(UploadFailure.safe(error) as NSError) }
    }
  }
  @objc(resolveCredentials:token:completion:)
  public func resolveCredentials(_ id: String, token: String, completion: @escaping @Sendable () -> Void) {
    Task { @MainActor in coordinator?.credentials.resolve(requestId: id, token: token); completion() }
  }
  @objc(rejectCredentials:completion:)
  public func rejectCredentials(_ id: String, completion: @escaping @Sendable () -> Void) {
    Task { @MainActor in coordinator?.credentials.reject(requestId: id); completion() }
  }
  @objc public func invalidate() {
    Task { @MainActor in destroyed = true; coordinator?.cancelAll(); credentialsRequested = nil; statusJobs.values.forEach { $0.cancel() }; statusJobs.removeAll() }
  }

  @MainActor private func service() -> UploadCoordinator {
    if let coordinator { return coordinator }
    let credentials = UploadCredentials()
    credentials.emit = { [weak self] requestId, operationId in
      self?.credentialsRequested?(requestId, operationId)
    }
    let journal = UploadJournal(root: FileManager.default.urls(for: .applicationSupportDirectory,
      in: .userDomainMask)[0].appendingPathComponent("BotaSDKUploadV2", isDirectory: true))
    let http = UploadURLSessionHTTP()
    let coordinator = UploadCoordinator(credentials: credentials, makeOperation: { input in
      UploadOperation(input: input, journal: journal, http: http, credentials: credentials,
        readNonce: { operationId in try await BotaDeviceSDKEncryptedUploadV2Materials.readAuthNonce(operationId) })
    }, register: { operation, prepared in
      let policy: EncryptedUploadV2SecurityPolicy
      switch prepared.session.policy {
      case "legacy_allowed": policy = .legacyAllowed
      case "v2_preferred": policy = .v2Preferred
      case "v2_required": policy = .v2Required
      default: throw UploadFailure.invalidDocument
      }
      guard let sessionId = UUID(uuidString: prepared.session.session_id) else { throw UploadFailure.invalidDocument }
      let submitMarkers: EncryptedUploadV2Material.MarkerSubmitter?
      if operation.input.recording.markersRequired == true {
        submitMarkers = { documents, evidence in
          try await operation.submitMarkers(documents, evidence: Self.evidence(evidence))
        }
      } else { submitMarkers = nil }
      let material = EncryptedUploadV2Material(
        materialID: UUID().uuidString.lowercased(), recordingID: operation.input.recording.uuid,
        uploadSessionID: sessionId, ownerRevision: prepared.session.owner_revision, policy: policy,
        authorization: prepared.authorization,
        stagingRequest: { try await operation.stagingRequest(Self.evidence($0)) },
        submitManifest: { try await operation.submitManifest($0, evidence: Self.evidence($1)) },
        finalize: { try await operation.finalize(Self.evidence($0)) },
        completionReceipt: { try await operation.completionReceipt(Self.evidence($0)) },
        cancel: { await operation.cancel() },
        uploadContext: { nonce in
          let context = try await operation.uploadContext(nonce)
          return EncryptedUploadV2ContextExchange(challenge: context.challenge, exchangeProof: context.exchangeProof)
        },
        shouldUploadCiphertext: { try await operation.shouldUpload(Self.evidence($0)) },
        reconcileStaging: { try await operation.reconcileStaging($0, evidence: Self.evidence($1)) },
        submitMarkers: submitMarkers
      )
      return BotaDeviceSDKEncryptedUploadV2Materials.register(material)
    }, unregister: { id in _ = BotaDeviceSDKEncryptedUploadV2Materials.remove(id) })
    self.coordinator = coordinator
    return coordinator
  }

  private static func evidence(_ evidence: EncryptedUploadV2TransferEvidence) -> UploadEvidence {
    UploadEvidence(ciphertextLength: evidence.ciphertextLength, ciphertextSHA256: evidence.ciphertextSHA256,
      manifestLength: evidence.manifestLength, manifestSHA256: evidence.manifestSHA256)
  }
}
