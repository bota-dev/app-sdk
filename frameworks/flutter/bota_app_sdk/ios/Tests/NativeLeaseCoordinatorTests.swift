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

  func testThrowingCancellationRetainsOwnerUntilOriginalOperationTerminates() async throws {
    let client = LeaseTestClient()
    let coordinator = NativeLeaseCoordinator(client: client)
    let otherCancellation = CancellationRecorder()
    try await coordinator.beginOperation(
      engineID: "engine-a",
      category: .device,
      operationID: "operation-a"
    )

    do {
      try await coordinator.cancelOperation(engineID: "engine-a", category: .device) {
        throw CancellationFailure.expected
      }
      XCTFail("expected native cancellation failure")
    } catch CancellationFailure.expected {}

    do {
      try await coordinator.beginOperation(
        engineID: "engine-b",
        category: .device,
        operationID: "operation-b"
      )
      XCTFail("failed cancellation must keep the category owned")
    } catch let error as NativeLeaseError {
      XCTAssertEqual(error, .operationInProgress)
    }
    do {
      try await coordinator.cancelOperation(engineID: "engine-b", category: .device) {
        await otherCancellation.record()
      }
      XCTFail("another engine must not cancel poisoned ownership")
    } catch let error as NativeLeaseError {
      XCTAssertEqual(error, .operationNotOwned)
    }
    let cancellationCount = await otherCancellation.count
    XCTAssertEqual(cancellationCount, 0)

    await coordinator.finishOperation(
      engineID: "engine-a",
      category: .device,
      operationID: "operation-a"
    )
    try await coordinator.beginOperation(
      engineID: "engine-b",
      category: .device,
      operationID: "operation-b"
    )
  }

  func testTerminalOperationWaitsForThrowingCancellationToReturnBeforeReleasingOwner() async throws
  {
    let client = LeaseTestClient()
    let coordinator = NativeLeaseCoordinator(client: client)
    let cancellation = ThrowingCancellationGate()
    try await coordinator.beginOperation(
      engineID: "engine-a",
      category: .device,
      operationID: "operation-a"
    )
    let cancel = Task {
      try await coordinator.cancelOperation(engineID: "engine-a", category: .device) {
        try await cancellation.run()
      }
    }
    await cancellation.waitUntilStarted()

    await coordinator.finishOperation(
      engineID: "engine-a",
      category: .device,
      operationID: "operation-a"
    )
    do {
      try await coordinator.beginOperation(
        engineID: "engine-b",
        category: .device,
        operationID: "operation-b"
      )
      XCTFail("cancellation closure is still accessing shared native state")
    } catch let error as NativeLeaseError {
      XCTAssertEqual(error, .operationInProgress)
    }

    await cancellation.fail()
    do {
      try await cancel.value
      XCTFail("expected native cancellation failure")
    } catch CancellationFailure.expected {}
    try await coordinator.beginOperation(
      engineID: "engine-b",
      category: .device,
      operationID: "operation-b"
    )
  }

  func testFinalClientDestructionClearsFailedCancellationOwnership() async throws {
    let client = LeaseTestClient()
    let coordinator = NativeLeaseCoordinator(client: client)
    let configuration = leaseConfiguration(namespace: "shared")
    try await coordinator.acquire(engineID: "engine-a", configuration: configuration)
    try await coordinator.beginOperation(
      engineID: "engine-a",
      category: .device,
      operationID: "operation-a"
    )
    do {
      try await coordinator.cancelOperation(engineID: "engine-a", category: .device) {
        throw CancellationFailure.expected
      }
      XCTFail("expected native cancellation failure")
    } catch CancellationFailure.expected {}

    await coordinator.release(engineID: "engine-a")

    try await coordinator.acquire(engineID: "engine-b", configuration: configuration)
    try await coordinator.beginOperation(
      engineID: "engine-b",
      category: .device,
      operationID: "operation-b"
    )
    let destroyCount = await client.destroyCount
    XCTAssertEqual(destroyCount, 1)
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

private enum CancellationFailure: Error {
  case expected
}

private actor ThrowingCancellationGate {
  private var started = false
  private var continuation: CheckedContinuation<Void, Never>?

  func run() async throws {
    started = true
    await withCheckedContinuation { continuation = $0 }
    throw CancellationFailure.expected
  }

  func waitUntilStarted() async {
    while !started { await Task.yield() }
  }

  func fail() {
    continuation?.resume()
    continuation = nil
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
