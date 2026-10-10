import Foundation
import XCTest
@testable import BotaAppSDK

final class ByoRecoveryHostTests: XCTestCase {
    func testPersistAndReadbackPrecedeReturningCleanupDecision() throws {
        let core = TestCoreAbi()
        core.enqueuePacket(reply())
        var disk: Data?
        var order: [String] = []
        let host = ByoRecoveryHost(core: try CoreAbiClient(abi: core),
            load: { order.append("load"); return disk },
            save: { order.append("save"); disk = $0 })
        let decision = try host.advance(fields: [])
        XCTAssertTrue(decision.mayCleanup)
        XCTAssertEqual(order, ["load", "save", "load"])
        XCTAssertEqual(disk, Data([1, 2, 3]))
    }

    func testFailedPersistenceOrReadbackNeverReturnsAnAction() throws {
        for writeThrows in [false, true] {
            let core = TestCoreAbi(); core.enqueuePacket(reply())
            let host = ByoRecoveryHost(core: try CoreAbiClient(abi: core), load: { nil }, save: { _ in
                if writeThrows { throw CocoaError(.fileWriteUnknown) }
            })
            XCTAssertThrowsError(try host.advance(fields: []))
        }
    }

    func testRenewalMetadataRemainsAvailableAfterPersistence() throws {
        let core = TestCoreAbi()
        core.enqueuePacket(.init(kind: 0x052d, operation: 0, requestID: 0,
            cancellationHigh: 0, cancellationLow: 0, fields: [
                .bytes(id: 28, value: Data([4, 5, 6])), .unsigned(id: 153, value: 5),
                .bool(id: 221, value: false), .unsigned(id: 222, value: 2),
                .text(id: 219, value: "00112233-4455-4677-8899-aabbccddeeff")]))
        var disk: Data?
        let host = ByoRecoveryHost(core: try CoreAbiClient(abi: core), load: { disk }, save: { disk = $0 })
        let decision = try host.advance(fields: [])
        XCTAssertEqual(decision.renewalRevision, 2)
        XCTAssertEqual(decision.renewalOperation, "00112233-4455-4677-8899-aabbccddeeff")
        XCTAssertFalse(decision.mayCleanup)
        XCTAssertEqual(disk, Data([4, 5, 6]))
    }

    func testLostRenewalResponseReusesPersistedOperation() throws {
        let core = TestCoreAbi()
        let pending = "00112233-4455-4677-8899-aabbccddeeff"
        core.enqueuePacket(.init(kind: 0x052d, operation: 0, requestID: 0,
            cancellationHigh: 0, cancellationLow: 0, fields: [
                .bytes(id: 28, value: Data([7])), .unsigned(id: 153, value: 5),
                .bool(id: 221, value: false), .unsigned(id: 222, value: 2), .text(id: 219, value: pending)]))
        var disk: Data? = Data([7])
        let host = ByoRecoveryHost(core: try CoreAbiClient(abi: core), load: { disk }, save: { disk = $0 })
        XCTAssertEqual(try host.prepareRenewal(scopeFields: [], operationId: UUID().uuidString.lowercased()),
            .init(operationId: pending, expectedRevision: 2))
        XCTAssertThrowsError(try host.acceptRenewal(scopeFields: [], request: .init(operationId: pending, expectedRevision: 2), revision: 4))
    }

    private func reply() -> CorePacket {
        .init(kind: 0x052d, operation: 0, requestID: 0, cancellationHigh: 0, cancellationLow: 0,
            fields: [.bytes(id: 28, value: Data([1, 2, 3])), .unsigned(id: 153, value: 8), .bool(id: 221, value: true)])
    }
}
