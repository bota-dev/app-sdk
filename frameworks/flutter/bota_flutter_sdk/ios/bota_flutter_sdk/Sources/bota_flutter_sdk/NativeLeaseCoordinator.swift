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

  private struct OperationOwner: Equatable {
    let engineID: String
    let operationID: String
    var isCancelling: Bool
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
      isCancelling: false
    )
  }

  func finishOperation(
    engineID: String,
    category: NativeOperationCategory,
    operationID: String
  ) {
    guard let owner = operations[category],
      owner.engineID == engineID,
      owner.operationID == operationID,
      !owner.isCancelling
    else { return }
    operations.removeValue(forKey: category)
  }

  func cancelOperation(
    engineID: String,
    category: NativeOperationCategory,
    cancellation: @escaping @Sendable () async throws -> Void
  ) async throws {
    if var owner = operations[category] {
      guard owner.engineID == engineID else { throw NativeLeaseError.operationNotOwned }
      guard !owner.isCancelling else { throw NativeLeaseError.operationInProgress }
      owner.isCancelling = true
      operations[category] = owner
      do {
        try await cancellation()
        if operations[category] == owner { operations.removeValue(forKey: category) }
      } catch {
        if operations[category] == owner { operations.removeValue(forKey: category) }
        throw error
      }
      return
    }
    try await cancellation()
  }

  func cancelOperations(
    engineID: String,
    cancellation: @escaping @Sendable (NativeOperationCategory) async -> Void
  ) async {
    let categories = NativeOperationCategory.allCases.filter {
      operations[$0]?.engineID == engineID
    }
    for category in categories {
      guard var owner = operations[category], owner.engineID == engineID else { continue }
      owner.isCancelling = true
      operations[category] = owner
      await cancellation(category)
      if operations[category] == owner { operations.removeValue(forKey: category) }
    }
  }

  private func requireCompatible(_ configuration: NativeLeaseConfiguration) throws {
    let current = activeConfiguration
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
    guard leases.isEmpty, pendingLeases.isEmpty, activeConfiguration != nil else { return }
    activeConfiguration = nil
    if let destroying {
      await destroying.task.value
      if self.destroying?.id == destroying.id { self.destroying = nil }
      return
    }
    let client = self.client
    let destroy = DestroyTask(id: UUID(), task: Task { await client.destroy() })
    destroying = destroy
    await destroy.task.value
    if destroying?.id == destroy.id { destroying = nil }
  }
}
