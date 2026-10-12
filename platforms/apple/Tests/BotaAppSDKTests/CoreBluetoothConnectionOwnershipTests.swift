import Foundation
import XCTest

@testable import BotaAppSDK

final class CoreBluetoothConnectionOwnershipTests: XCTestCase {
    private let peripheralID = UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")!

    func testSystemConnectionWaitsForThisCentralsCallbackBeforeOwningTheLink() async throws {
        let fixture = ConnectionFixture()
        let id = peripheralID
        let task = Task { try await fixture.connect(id, systemConnected: true) }
        try await waitUntil { await fixture.requestCount == 1 }

        let starts = await fixture.starts
        let identityBeforeCallback = await fixture.identity(peripheralID)
        XCTAssertEqual(starts, 1)
        XCTAssertNil(identityBeforeCallback)

        await fixture.didConnect(peripheralID)
        try await task.value
        let identityAfterCallback = await fixture.identity(peripheralID)
        XCTAssertNotNil(identityAfterCallback)
    }

    func testLocallyOwnedConnectedLinkReusesItsIdentityWithoutAnotherConnect() async throws {
        let fixture = ConnectionFixture()
        await fixture.didConnect(peripheralID)
        let originalIdentity = await fixture.identity(peripheralID)

        try await fixture.connect(peripheralID, systemConnected: true)

        let starts = await fixture.starts
        let reusedIdentity = await fixture.identity(peripheralID)
        XCTAssertEqual(starts, 0)
        XCTAssertEqual(reusedIdentity, originalIdentity)
    }

    func testDisconnectRequiresLocalReconnectEvenWhenTheSystemLinkRemainsConnected() async throws {
        let fixture = ConnectionFixture()
        await fixture.didConnect(peripheralID)
        let originalIdentity = await fixture.identity(peripheralID)
        await fixture.didDisconnect(peripheralID)
        let id = peripheralID
        let task = Task { try await fixture.connect(id, systemConnected: true) }
        try await waitUntil { await fixture.requestCount == 1 }

        let starts = await fixture.starts
        let identityBeforeCallback = await fixture.identity(peripheralID)
        XCTAssertEqual(starts, 1)
        XCTAssertNil(identityBeforeCallback)

        await fixture.didConnect(peripheralID)
        try await task.value
        let replacementIdentity = await fixture.identity(peripheralID)
        XCTAssertNotEqual(replacementIdentity, originalIdentity)
    }

    func testFailedLocalConnectDoesNotAcquireSystemConnectionOwnership() async throws {
        let fixture = ConnectionFixture()
        let id = peripheralID
        let task = Task { try await fixture.connect(id, systemConnected: true) }
        try await waitUntil { await fixture.requestCount == 1 }
        await fixture.didFailToConnect(peripheralID)

        do {
            try await task.value
            XCTFail("the local connect failure must reach its caller")
        } catch {
            XCTAssertEqual(error as? CentralDriverError, .bluetoothUnavailable)
        }
        let identity = await fixture.identity(peripheralID)
        XCTAssertNil(identity)
    }

    func testBluetoothLossClearsLocalOwnershipAndFailsPendingConnection() async throws {
        let fixture = ConnectionFixture()
        await fixture.didConnect(peripheralID)
        let pendingID = UUID(uuidString: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB")!
        let task = Task { try await fixture.connect(pendingID, systemConnected: false) }
        try await waitUntil { await fixture.requestCount == 1 }
        await fixture.bluetoothUnavailable()

        do {
            try await task.value
            XCTFail("Bluetooth loss must settle the pending local connection")
        } catch {
            XCTAssertEqual(error as? CentralDriverError, .bluetoothUnavailable)
        }
        let identity = await fixture.identity(peripheralID)
        XCTAssertNil(identity)
    }

    private func waitUntil(_ condition: @escaping @Sendable () async -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !(await condition()) {
            if ContinuousClock.now >= deadline { throw CentralDriverError.bluetoothUnavailable }
            await Task.yield()
        }
    }
}

private actor ConnectionFixture {
    private var ownership = CoreBluetoothConnectionOwnership()
    private(set) var starts = 0
    private(set) var requestCount = 0

    func connect(_ id: UUID, systemConnected: Bool) async throws {
        requestCount += 1
        try await withCheckedThrowingContinuation { continuation in
            ownership.connect(id, systemConnected: systemConnected, continuation: continuation) {
                starts += 1
            }
        }
    }

    func identity(_ id: UUID) -> String? { ownership.identity(id) }
    func didConnect(_ id: UUID) { ownership.didConnect(id) }
    func didDisconnect(_ id: UUID) { ownership.didDisconnect(id, error: CentralDriverError.disconnected(id.uuidString)) }
    func didFailToConnect(_ id: UUID) { ownership.didFailToConnect(id, error: CentralDriverError.bluetoothUnavailable) }
    func bluetoothUnavailable() { ownership.clear(error: CentralDriverError.bluetoothUnavailable) }
}
