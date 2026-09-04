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
  let hasUploadDestinationCallback: Bool
  let hasFirmwareCallback: Bool
}

enum NativeLeaseError: Error, Equatable {
  case configurationConflict
}

actor NativeLeaseCoordinator {
  static let shared = NativeLeaseCoordinator(client: BotaAppleNativeClient.shared)

  private let client: any NativeLeaseClientProtocol
  private var leases: [String: NativeLeaseConfiguration] = [:]
  private var activeConfiguration: NativeLeaseConfiguration?
  private var configuring:
    (
      configuration: NativeLeaseConfiguration,
      task: Task<Void, Error>
    )?
  private var destroying: Task<Void, Never>?

  init(client: any NativeLeaseClientProtocol) {
    self.client = client
  }

  var leaseCount: Int { leases.count }

  func acquire(engineID: String, configuration: NativeLeaseConfiguration) async throws {
    if let existing = leases[engineID] {
      guard existing == configuration else { throw NativeLeaseError.configurationConflict }
      return
    }

    if let destroying {
      await destroying.value
      self.destroying = nil
    }

    if let activeConfiguration {
      guard activeConfiguration == configuration else {
        throw NativeLeaseError.configurationConflict
      }
      leases[engineID] = configuration
      return
    }

    if let configuring {
      guard configuring.configuration == configuration else {
        throw NativeLeaseError.configurationConflict
      }
      try await configuring.task.value
      activeConfiguration = configuration
      self.configuring = nil
      leases[engineID] = configuration
      return
    }

    let client = self.client
    let task = Task {
      try await client.configure(
        applicationSupportDirectory: configuration.applicationSupportDirectory
      )
    }
    configuring = (configuration, task)

    do {
      try await task.value
      activeConfiguration = configuration
      configuring = nil
      leases[engineID] = configuration
    } catch {
      configuring = nil
      throw error
    }
  }

  func release(engineID: String) async {
    guard leases.removeValue(forKey: engineID) != nil else { return }
    guard leases.isEmpty else { return }

    activeConfiguration = nil
    let client = self.client
    let task = Task { await client.destroy() }
    destroying = task
    await task.value
    if leases.isEmpty {
      destroying = nil
    }
  }
}
