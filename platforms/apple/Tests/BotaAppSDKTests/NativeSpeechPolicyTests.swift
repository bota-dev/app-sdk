import Foundation
import XCTest

@testable import BotaAppSDK

final class NativeSpeechPolicyTests: XCTestCase {
    private let now: UInt64 = 1_793_491_200_000

    private func policy() throws -> NativeSpeechPolicy {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "client-v1", withExtension: "json", subdirectory: "SpeechFixtures"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try NativeSpeechPolicy(
            configurationJSON: JSONSerialization.data(withJSONObject: fixture["configuration"]!),
            grantJSON: JSONSerialization.data(withJSONObject: fixture["grant"]!), nowMs: now
        )
    }

    private func step(_ policy: NativeSpeechPolicy, _ command: [String: Any]) throws -> [String: Any] {
        let output = try policy.step(commandJSON: JSONSerialization.data(withJSONObject: command), nowMs: now)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: output) as? [String: Any])
    }

    func testNativePolicyKeepsCaptureIndependentOfListeningAndClosesTerminally() throws {
        let policy = try policy()
        defer { policy.close() }
        XCTAssertEqual(try step(policy, ["type": "connected"])["connected"] as? Bool, true)
        XCTAssertEqual(try step(policy, ["type": "set_microphone", "enabled": true])["canCapture"] as? Bool, true)
        let changed = try step(policy, ["type": "begin_change"])
        XCTAssertEqual(changed["canCapture"] as? Bool, true)
        XCTAssertEqual(changed["canPlay"] as? Bool, false)
        policy.close()
        policy.close()
        XCTAssertThrowsError(try step(policy, ["type": "connected"])) { error in
            XCTAssertEqual((error as? CoreError)?.code, 14)
        }
        let replacement = try self.policy()
        defer { replacement.close() }
        XCTAssertEqual(try step(replacement, ["type": "connected"])["connected"] as? Bool, true)
    }

    func testMalformedInputClosesOwnerAndErrorsDoNotEchoCredentials() throws {
        let policy = try policy()
        XCTAssertThrowsError(try policy.step(commandJSON: Data([0xff]), nowMs: now)) { error in
            XCTAssertEqual((error as? CoreError)?.code, 1)
        }
        XCTAssertThrowsError(try step(policy, ["type": "tick"]))
        XCTAssertThrowsError(try NativeSpeechPolicy(configurationJSON: Data("{}".utf8),
                                                    grantJSON: Data("PRIVATE_TOKEN_CANARY".utf8), nowMs: now)) { error in
            XCTAssertFalse(String(describing: error).contains("PRIVATE_TOKEN_CANARY"))
        }
    }

    func testConcurrentCloseAndStepNeverUseFreedHandle() throws {
        let policy = try policy()
        let command = Data("{\"type\":\"tick\"}".utf8)
        let now = now
        DispatchQueue.concurrentPerform(iterations: 64) { index in
            if index.isMultiple(of: 3) { policy.close() }
            else { _ = try? policy.step(commandJSON: command, nowMs: now) }
        }
        XCTAssertThrowsError(try step(policy, ["type": "connected"]))
    }
}
