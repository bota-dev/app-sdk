import Foundation
import XCTest

@testable import BotaDeviceSDK

final class WorkflowConformanceTests: XCTestCase {
    func testAllCanonicalWorkflowTracesMapToAppleCoreTypes() throws {
        let resource = try XCTUnwrap(
            Bundle.module.url(forResource: "workflows", withExtension: "json", subdirectory: "WorkflowFixtures")
        )
        let suite = try JSONDecoder().decode(WorkflowFixtureSuite.self, from: Data(contentsOf: resource))

        XCTAssertEqual(suite.schemaVersion, 1)
        XCTAssertEqual(suite.scenarios.count, 29)
        XCTAssertEqual(Set(suite.scenarios.map(\.name)).count, 29)
        XCTAssertEqual(Set(suite.scenarios.map(\.workflow)).count, 7)

        for scenario in suite.scenarios {
            XCTAssertNotNil(CoreCommand.fixture(named: scenario.command), scenario.name)
            XCTAssertNoThrow(try CoreCapabilities(names: scenario.capabilities), scenario.name)
            XCTAssertTrue(scenario.effects.allSatisfy(WorkflowTraceVocabulary.effects.contains), scenario.name)
            XCTAssertTrue(
                scenario.notifications.allSatisfy(WorkflowTraceVocabulary.notifications.contains),
                scenario.name
            )
            XCTAssertTrue(WorkflowTraceVocabulary.terminalStatuses.contains(scenario.terminalStatus), scenario.name)
        }
    }
}

private struct WorkflowFixtureSuite: Decodable {
    let schemaVersion: Int
    let scenarios: [WorkflowFixtureScenario]
}

private struct WorkflowFixtureScenario: Decodable {
    let workflow: String
    let name: String
    let command: String
    let capabilities: [String]
    let effects: [String]
    let notifications: [String]
    let terminalStatus: String
}

private enum WorkflowTraceVocabulary {
    static let effects: Set<String> = [
        "abort", "append_new_sequence", "append_sink", "cancel_timer", "cleanup_subscription",
        "confirm_delete", "connect", "connect_next", "delete_checkpoint", "delete_result", "disconnect", "discover_services",
        "discard_sink", "download", "final_ack", "finalize_sink", "load_checkpoint", "nack", "prepare_material",
        "read_blob_chunks", "read_blob_from_zero", "read_nonce", "read_public_key", "read_serial", "read_status",
        "read_version", "reconnect", "restart_transfer", "save_checkpoint", "save_identity", "save_result",
        "skip_durable_sequence", "start_logging", "start_scan", "start_transfer", "start_upload", "stop_logging",
        "stop_scan", "subscribe", "truncate_sink", "truncate_to_checkpoint", "unsubscribe", "verify",
        "write_chunks", "write_grant", "write_receipt", "write_reset",
    ]
    static let notifications: Set<String> = [
        "ble_fallback_ready", "cancelled", "completed", "connection_established", "device_log", "failed",
        "firmware_progress", "progress", "retrying", "started",
    ]
    static let terminalStatuses: Set<String> = ["idle", "running", "completed", "cancelled", "failed"]
}
