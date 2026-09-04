import XCTest

@testable import BotaFlutterSdk

@MainActor
final class NativeLeaseCoordinatorTests: XCTestCase {
  func testEquivalentConfigurationCoalescesAcrossEngines() async throws {
    let client = LeaseTestClient(suspendConfigure: true)
    let coordinator = NativeLeaseCoordinator(client: client)
    let configuration = leaseConfiguration(namespace: "shared")

    async let first: Void = coordinator.acquire(
      engineID: "engine-a",
      configuration: configuration
    )
    await client.waitUntilConfigureStarted()
    async let second: Void = coordinator.acquire(
      engineID: "engine-b",
      configuration: configuration
    )
    await client.resumeConfigure()
    try await first
    try await second

    let configureCount = await client.configureCount
    let leaseCount = await coordinator.leaseCount
    XCTAssertEqual(configureCount, 1)
    XCTAssertEqual(leaseCount, 2)
  }

  func testReleaseDuringSuspendedConfigureCannotInstallDetachedLease() async throws {
    let client = LeaseTestClient(suspendConfigure: true)
    let coordinator = NativeLeaseCoordinator(client: client)
    let acquire = Task {
      try await coordinator.acquire(
        engineID: "engine-a",
        configuration: leaseConfiguration(namespace: "shared")
      )
    }
    await client.waitUntilConfigureStarted()

    await coordinator.release(engineID: "engine-a")
    await client.resumeConfigure()

    do {
      try await acquire.value
      XCTFail("expected detached acquisition to be cancelled")
    } catch let error as NativeLeaseError {
      XCTAssertEqual(error, .acquisitionCancelled)
    }
    let leaseCount = await coordinator.leaseCount
    let destroyCount = await client.destroyCount
    XCTAssertEqual(leaseCount, 0)
    XCTAssertEqual(destroyCount, 1)
  }

  func testConflictingConfigurationFailsWithoutReconfiguringClient() async throws {
    let client = LeaseTestClient()
    let coordinator = NativeLeaseCoordinator(client: client)
    try await coordinator.acquire(
      engineID: "engine-a",
      configuration: leaseConfiguration(namespace: "first")
    )

    do {
      try await coordinator.acquire(
        engineID: "engine-b",
        configuration: leaseConfiguration(namespace: "second")
      )
      XCTFail("expected a configuration conflict")
    } catch let error as NativeLeaseError {
      XCTAssertEqual(error, .configurationConflict)
    }

    let configureCount = await client.configureCount
    let leaseCount = await coordinator.leaseCount
    XCTAssertEqual(configureCount, 1)
    XCTAssertEqual(leaseCount, 1)
  }

  func testFinalReleaseDestroysSharedClientExactlyOnce() async throws {
    let client = LeaseTestClient()
    let coordinator = NativeLeaseCoordinator(client: client)
    let configuration = leaseConfiguration(namespace: "shared")
    try await coordinator.acquire(engineID: "engine-a", configuration: configuration)
    try await coordinator.acquire(engineID: "engine-b", configuration: configuration)

    await coordinator.release(engineID: "engine-a")
    let firstDestroyCount = await client.destroyCount
    let firstLeaseCount = await coordinator.leaseCount
    XCTAssertEqual(firstDestroyCount, 0)
    XCTAssertEqual(firstLeaseCount, 1)

    await coordinator.release(engineID: "engine-b")
    await coordinator.release(engineID: "engine-b")
    let finalDestroyCount = await client.destroyCount
    let finalLeaseCount = await coordinator.leaseCount
    XCTAssertEqual(finalDestroyCount, 1)
    XCTAssertEqual(finalLeaseCount, 0)
  }

  func testOwnerlessCancellationDoesNotInvokeNativeClosure() async throws {
    let client = LeaseTestClient()
    let coordinator = NativeLeaseCoordinator(client: client)
    let cancellation = CancellationRecorder()

    try await coordinator.cancelOperation(engineID: "engine-a", category: .device) {
      await cancellation.record()
    }

    let count = await cancellation.count
    XCTAssertEqual(count, 0)
  }

  private func leaseConfiguration(namespace: String) -> NativeLeaseConfiguration {
    NativeLeaseConfiguration(
      applicationSupportDirectory: URL(fileURLWithPath: "/tmp/\(namespace)"),
      applicationSupportNamespace: namespace,
      hasProvisioningMaterialCallback: true,
      hasFactoryResetGrantCallback: true,
      hasFactoryResetResultCallback: true,
      hasFirmwareCallback: true
    )
  }
}

private actor CancellationRecorder {
  private(set) var count = 0

  func record() { count += 1 }
}

private actor LeaseTestClient: NativeLeaseClientProtocol {
  private(set) var configureCount = 0
  private(set) var destroyCount = 0
  private let suspendConfigure: Bool
  private var configureStarted = false
  private var configureContinuation: CheckedContinuation<Void, Never>?

  init(suspendConfigure: Bool = false) {
    self.suspendConfigure = suspendConfigure
  }

  func configure(applicationSupportDirectory: URL) async throws {
    configureCount += 1
    configureStarted = true
    guard suspendConfigure else { return }
    await withCheckedContinuation { configureContinuation = $0 }
  }

  func waitUntilConfigureStarted() async {
    while !configureStarted { await Task.yield() }
  }

  func resumeConfigure() {
    configureContinuation?.resume()
    configureContinuation = nil
  }

  func destroy() async { destroyCount += 1 }
}
