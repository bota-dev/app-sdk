import Foundation
import XCTest
@testable import BotaAppSDK

final class ClientPresenceTests: XCTestCase {
    func testCanonicalLifecycle() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("protocol/client-presence/v1.json"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        var presence = ConnectionClientPresence()
        var tokens: [String: String] = [:]
        var nextSession = 0
        for step in fixture.steps {
            switch step.action {
            case "verified_connect":
                let id = fixture.sessions[min(nextSession, fixture.sessions.count - 1)]
                tokens[step.connection!] = id
                presence.connected(deviceID: step.device_id!, sessionID: id, transportID: id)
                nextSession += 1
            case "disconnect": presence.disconnected(sessionID: tokens[step.connection!]!)
            case "destroy": presence.destroy()
            case "report":
                let report = presence.nextReport(deviceID: step.device_id!)
                if let expected = step.expected {
                    XCTAssertEqual(report?.sessionID, fixture.sessions[expected.session])
                    XCTAssertEqual(report?.sequence, expected.sequence)
                    XCTAssertEqual(report?.sdkPackage, SdkIdentity.package)
                    XCTAssertEqual(report?.sdkVersion, SdkIdentity.version)
                } else { XCTAssertNil(report) }
            default: XCTFail("unknown fixture action")
            }
        }
    }

    private struct Fixture: Decodable {
        let sessions: [String]
        let steps: [Step]
    }
    private struct Step: Decodable {
        let action: String
        let device_id: String?
        let connection: String?
        let expected: Expected?
    }
    private struct Expected: Decodable { let session: Int; let sequence: Int64 }
}
