import Foundation
import XCTest
@testable import BotaAppSDK

final class ByoDurableStoreTests: XCTestCase {
    func testRoundTripAndFailedFlush() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try ByoDurableStore(root: root)
        XCTAssertNil(try store.load("state"))
        try store.save("state", Data([1, 2, 3]))
        XCTAssertEqual(try store.load("state"), Data([1, 2, 3]))
        XCTAssertThrowsError(try store.save("../escape", Data()))
        XCTAssertThrowsError(try ByoDurableStore(root: root, synchronize: { _ in -1 }))
    }
}
