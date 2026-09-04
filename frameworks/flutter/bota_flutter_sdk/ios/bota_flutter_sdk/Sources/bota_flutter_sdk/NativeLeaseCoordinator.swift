import Foundation

protocol NativeLeaseClientProtocol: Sendable {
  func configure(applicationSupportDirectory: URL) async throws
  func destroy() async
}

struct NativeLeaseConfiguration: Equatable, Sendable {
  let applicationSupportDirectory: URL
  let applicationSupportNamespace: String
  let hasProvisioningMaterialCallback: Bool
  let hasFactoryResetGrantCallback: Bool
  let hasFactoryResetResultCallback: Bool
  let hasFirmwareCallback: Bool
}

enum NativeOperationCategory: CaseIterable, Hashable, Sendable {
  case device
  case provisioning
  case factoryReset
  case recording
  case ota
  case logs
  case wifi
}

enum NativeLeaseError: Error, Equatable {
  case configurationConflict
  case acquisitionCancelled
  case operationInProgress
  case operationNotOwned
}

struct NativeOwnedOperation: Equatable, Sendable {
  let category: NativeOperationCategory
  let operationID: String
}

actor NativeLeaseCoordinator {
  static let shared = NativeLeaseCoordinator(client: BotaAppleNativeClient.shared)

  private struct ConfigurationTask {
    let id: UUID
    let configuration: NativeLeaseConfiguration
    let task: Task<Void, Error>
  }

  private struct DestroyTask {
    let id: UUID
    let task: Task<Void, Never>
  }

  private enum CancellationOutcome: @unchecked Sendable {
    case success
    case failure(Error)
  }

  private struct OperationCancellation {
    let id: UUID
    let task: Task<CancellationOutcome, Never>
    var status: CancellationStatus
  }

  private enum CancellationStatus: Equatable {
    case inProgress
    case succeeded
    case failed
  }

  private struct OperationOwner {
    let engineID: String
    let operationID: String
    var cancellation: OperationCancellation?
    var operationTerminated: Bool
    var retainAfterCancellation: Bool
  }

  private let client: any NativeLeaseClientProtocol
  private var leases: [String: NativeLeaseConfiguration] = [:]
  private var pendingLeases: [String: NativeLeaseConfiguration] = [:]
  private var activeConfiguration: NativeLeaseConfiguration?
  private var configuring: ConfigurationTask?
  private var destroying: DestroyTask?
  private var operations: [NativeOperationCategory: OperationOwner] = [:]

  init(client: any NativeLeaseClientProtocol) {
    self.client = client
  }

  var leaseCount: Int { leases.count }

  func acquire(engineID: String, configuration: NativeLeaseConfiguration) async throws {
    if let existing = leases[engineID] {
      guard existing == configuration else { throw NativeLeaseError.configurationConflict }
      return
    }
    if let pending = pendingLeases[engineID] {
      guard pending == configuration else { throw NativeLeaseError.configurationConflict }
    } else {
      try requireCompatible(configuration)
      pendingLeases[engineID] = configuration
    }

    if let destroying {
      await destroying.task.value
      if self.destroying?.id == destroying.id { self.destroying = nil }
      guard pendingLeases[engineID] != nil else {
        throw NativeLeaseError.acquisitionCancelled
      }
    }

    if let activeConfiguration {
      guard activeConfiguration == configuration else {
        pendingLeases.removeValue(forKey: engineID)
        throw NativeLeaseError.configurationConflict
      }
    } else {
      let configurationTask: ConfigurationTask
      if let configuring {
        guard configuring.configuration == configuration else {
          pendingLeases.removeValue(forKey: engineID)
          throw NativeLeaseError.configurationConflict
        }
        configurationTask = configuring
      } else {
        let client = self.client
        configurationTask = ConfigurationTask(
          id: UUID(),
          configuration: configuration,
          task: Task {
            try await client.configure(
              applicationSupportDirectory: configuration.applicationSupportDirectory
            )
          }
        )
        configuring = configurationTask
      }

      do {
        try await configurationTask.task.value
        completeConfiguration(configurationTask)
      } catch {
        if configuring?.id == configurationTask.id { configuring = nil }
        pendingLeases.removeValue(forKey: engineID)
        throw error
      }
    }

    if let existing = leases[engineID] {
      guard existing == configuration else { throw NativeLeaseError.configurationConflict }
      return
    }
    guard pendingLeases.removeValue(forKey: engineID) != nil else {
      await destroyIfUnused()
      throw NativeLeaseError.acquisitionCancelled
    }
    leases[engineID] = configuration
  }

  func release(engineID: String) async {
    let removedLease = leases.removeValue(forKey: engineID)
    let removedPending = pendingLeases.removeValue(forKey: engineID)
    guard removedLease != nil || removedPending != nil else { return }
    guard leases.isEmpty, pendingLeases.isEmpty else { return }

    // The suspended acquirer owns completion cleanup. Detach must not wait for
    // native configuration to return before it can revoke the pending lease.
    if configuring != nil { return }
    await destroyIfUnused()
  }

  func beginOperation(
    engineID: String,
    category: NativeOperationCategory,
    operationID: String
  ) throws {
    guard operations[category] == nil else { throw NativeLeaseError.operationInProgress }
    operations[category] = OperationOwner(
      engineID: engineID,
      operationID: operationID,
      cancellation: nil,
      operationTerminated: false,
      retainAfterCancellation: false
    )
  }

  func finishOperation(
    engineID: String,
    category: NativeOperationCategory,
    operationID: String
  ) {
    guard var owner = operations[category],
      owner.engineID == engineID,
      owner.operationID == operationID
    else { return }
    owner.operationTerminated = true
    guard let cancellation = owner.cancellation else {
      if owner.retainAfterCancellation {
        operations[category] = owner
      } else {
        operations.removeValue(forKey: category)
      }
      return
    }
    if cancellation.status == .inProgress || owner.retainAfterCancellation {
      operations[category] = owner
    } else {
      operations.removeValue(forKey: category)
    }
  }

  func cancelOperation(
    engineID: String,
    category: NativeOperationCategory,
    cancellation: @escaping @Sendable () async throws -> Void
  ) async throws {
    guard var owner = operations[category] else { return }
    guard owner.engineID == engineID else { throw NativeLeaseError.operationNotOwned }
    guard owner.cancellation == nil else { throw NativeLeaseError.operationInProgress }

    let cancellationID = UUID()
    let task = Task<CancellationOutcome, Never> {
      do {
        try await cancellation()
        return .success
      } catch {
        return .failure(error)
      }
    }
    owner.cancellation = OperationCancellation(
      id: cancellationID,
      task: task,
      status: .inProgress
    )
    operations[category] = owner
    let outcome = await task.value
    settleCancellation(
      engineID: engineID,
      category: category,
      operationID: owner.operationID,
      cancellationID: cancellationID,
      outcome: outcome
    )
    if case .failure(let error) = outcome { throw error }
  }

  func beginCancellingOperations(
    engineID: String,
    cancellation: @escaping @Sendable (NativeOperationCategory) async throws -> Void
  ) -> [NativeOwnedOperation] {
    let owned: [NativeOwnedOperation] = NativeOperationCategory.allCases.compactMap {
      category -> NativeOwnedOperation? in
      guard let owner = operations[category], owner.engineID == engineID else { return nil }
      return NativeOwnedOperation(category: category, operationID: owner.operationID)
    }
    for operation in owned {
      guard var owner = operations[operation.category],
        owner.engineID == engineID,
        owner.operationID == operation.operationID
      else { continue }
      owner.retainAfterCancellation = true
      if owner.cancellation == nil {
        let category = operation.category
        owner.cancellation = OperationCancellation(
          id: UUID(),
          task: Task {
            do {
              try await cancellation(category)
              return .success
            } catch {
              return .failure(error)
            }
          },
          status: .inProgress
        )
      }
      operations[operation.category] = owner
    }
    return owned
  }

  func waitForOperationCancellations(
    engineID: String,
    operations owned: [NativeOwnedOperation]
  ) async {
    for operation in owned {
      guard let owner = operations[operation.category],
        owner.engineID == engineID,
        owner.operationID == operation.operationID,
        let cancellation = owner.cancellation
      else { continue }
      let outcome = await cancellation.task.value
      settleCancellation(
        engineID: engineID,
        category: operation.category,
        operationID: operation.operationID,
        cancellationID: cancellation.id,
        outcome: outcome
      )
    }
  }

  func finishCancelledOperations(
    engineID: String,
    operations owned: [NativeOwnedOperation],
    terminalOperationIDs: Set<String>
  ) {
    for operation in owned {
      guard var owner = operations[operation.category],
        owner.engineID == engineID,
        owner.operationID == operation.operationID,
        owner.retainAfterCancellation
      else { continue }
      if terminalOperationIDs.contains(operation.operationID) {
        owner.operationTerminated = true
      }
      owner.retainAfterCancellation = false
      guard let cancellation = owner.cancellation else {
        if owner.operationTerminated {
          operations.removeValue(forKey: operation.category)
        } else {
          operations[operation.category] = owner
        }
        continue
      }
      if cancellation.status == .succeeded || owner.operationTerminated {
        operations.removeValue(forKey: operation.category)
      } else {
        operations[operation.category] = owner
      }
    }
  }

  private func settleCancellation(
    engineID: String,
    category: NativeOperationCategory,
    operationID: String,
    cancellationID: UUID,
    outcome: CancellationOutcome
  ) {
    guard var owner = operations[category],
      owner.engineID == engineID,
      owner.operationID == operationID,
      var cancellation = owner.cancellation,
      cancellation.id == cancellationID
    else { return }
    switch outcome {
    case .success: cancellation.status = .succeeded
    case .failure: cancellation.status = .failed
    }
    owner.cancellation = cancellation
    let nativeCleanupSucceeded = cancellation.status == .succeeded
    if !owner.retainAfterCancellation && (nativeCleanupSucceeded || owner.operationTerminated) {
      operations.removeValue(forKey: category)
    } else {
      operations[category] = owner
    }
  }

  private func requireCompatible(_ configuration: NativeLeaseConfiguration) throws {
    let current =
      activeConfiguration
      ?? configuring?.configuration
      ?? leases.values.first
      ?? pendingLeases.values.first
    if let current, current != configuration { throw NativeLeaseError.configurationConflict }
  }

  private func completeConfiguration(_ completed: ConfigurationTask) {
    guard configuring?.id == completed.id else { return }
    activeConfiguration = completed.configuration
    configuring = nil
  }

  private func destroyIfUnused() async {
    guard leases.isEmpty, pendingLeases.isEmpty else { return }
    if let destroying {
      await destroying.task.value
      if self.destroying?.id == destroying.id { self.destroying = nil }
      operations.removeAll()
      return
    }
    guard activeConfiguration != nil else {
      if configuring == nil { operations.removeAll() }
      return
    }
    activeConfiguration = nil
    let client = self.client
    let destroy = DestroyTask(id: UUID(), task: Task { await client.destroy() })
    destroying = destroy
    await destroy.task.value
    if destroying?.id == destroy.id { destroying = nil }
    operations.removeAll()
  }
}
