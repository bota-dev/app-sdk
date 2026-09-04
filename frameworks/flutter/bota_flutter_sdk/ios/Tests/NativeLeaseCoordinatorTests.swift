import XCTest

@testable import BotaFlutterSdk

@MainActor
final class NativeLeaseCoordinatorTests: XCTestCase {
  func testEquivalentConfigurationCoalescesAcrossEngines() async throws {
    let client = LeaseTestClient()
    let coordinator = NativeLeaseCoordinator(client: client)
    let configuration = leaseConfiguration(namespace: "shared")

    async let first: Void = coordinator.acquire(
      engineID: "engine-a",
      configuration: configuration
    )
    async let second: Void = coordinator.acquire(
      engineID: "engine-b",
      configuration: configuration
    )
    try await first
    try await second

    let configureCount = await client.configureCount
    let leaseCount = await coordinator.leaseCount
    XCTAssertEqual(configureCount, 1)
    XCTAssertEqual(leaseCount, 2)
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

  private func leaseConfiguration(namespace: String) -> NativeLeaseConfiguration {
    NativeLeaseConfiguration(
      applicationSupportDirectory: URL(fileURLWithPath: "/tmp/\(namespace)"),
      applicationSupportNamespace: namespace,
      hasProvisioningMaterialCallback: true,
      hasFactoryResetGrantCallback: true,
      hasFactoryResetResultCallback: true,
      hasUploadDestinationCallback: true,
      hasFirmwareCallback: true
    )
  }
}

private actor LeaseTestClient: NativeLeaseClientProtocol {
  private(set) var configureCount = 0
  private(set) var destroyCount = 0

  func configure(applicationSupportDirectory: URL) async throws { configureCount += 1 }
  func destroy() async { destroyCount += 1 }
}
