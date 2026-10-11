import XCTest
@testable import BotaAppSDK

final class ByoContinuousInstantTests: XCTestCase {
    func testRefreshAndSessionDeadlineBoundaries() {
        let start = ByoContinuousInstant(nanoseconds: 9_000_000_000)
        XCTAssertEqual(start.seconds(to: .init(nanoseconds: 39_000_000_000)), 30)
        XCTAssertGreaterThan(start.seconds(to: .init(nanoseconds: 39_000_000_001)), 30)
        XCTAssertLessThan(start.seconds(to: .init(nanoseconds: 14_408_999_999_999)), 14_400)
        XCTAssertEqual(start.seconds(to: .init(nanoseconds: 14_409_000_000_000)), 14_400)
    }

    func testClockIsMonotonic() {
        let start = ByoContinuousInstant.now
        XCTAssertGreaterThanOrEqual(start.seconds(to: .now), 0)
    }
}
