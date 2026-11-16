import BotaAppSDK
import Foundation
@testable import SpeechCompanion

@MainActor private final class RecordingConnectionFixture: RecordingSpeechConnection {
    var closed = 0, target = "", failClose = false
    func changeTarget(language: String, requestId: String) async throws { target = language }
    func qualifyHeadphones() async throws -> Bool { true }
    func finish() async throws {}
    func close() async throws { closed += 1; if failClose { throw CheckFailure(message: "synthetic cleanup failure") } }
}
final class RecordingBridgeChecks: @unchecked Sendable {
    @MainActor func testRecordingBridgePreservesPartialCreationCleanupFailure() async throws {
        var calls = 0
        let bridge = RecordingLabBridge { _, _, _ in calls += 1; throw RecordingCleanupFailure() }
        var refused = false
        do { try await bridge.start(String(repeating: "e", count: 32), activityId: "activity") } catch { refused = true }
        try require(refused); refused = false
        do { try await bridge.close() } catch { refused = true }; try require(refused); refused = false
        do { try await bridge.start(String(repeating: "f", count: 32), activityId: "other") } catch { refused = true }
        try require(refused); try require(calls == 1)
    }
    @MainActor func testRecordingBridgeControlsAndCleanupStayNative() async throws {
        let native = RecordingConnectionFixture(), id = String(repeating: "a", count: 32)
        let bridge = RecordingLabBridge { _, _, status in status("interrupted"); return native }
        try await bridge.start(id, activityId: "activity")
        let events = try await bridge.events(id)
        try require(events.contains("interrupted")); try require(!events.contains("token"))
        try await bridge.call(id) { try await $0.changeTarget(language: "ja", requestId: "change-1") }
        try require(native.target == "ja"); let qualified = try await bridge.call(id) { try await $0.qualifyHeadphones() }; try require(qualified)
        try await bridge.close(id); try require(native.closed == 1)
    }
    @MainActor func testRecordingBridgeJoinsAndRetiresLateAdmission() async throws {
        let native = RecordingConnectionFixture(), entered = Gate(), released = Gate(), closed = Gate(), id = String(repeating: "b", count: 32)
        let bridge = RecordingLabBridge { _, _, _ in entered.open(); try await released.wait(); return native }
        let starting = Task { try await bridge.start(id, activityId: "activity") }
        try await entered.wait()
        let closing = Task { try await bridge.close(id); closed.open() }
        await Task.yield(); try require(!closed.isOpen); released.open()
        try await closing.value; _ = await starting.result; try require(native.closed == 1)
    }
    @MainActor func testRecordingBridgeCleanupFailureBlocksReplacement() async throws {
        let native = RecordingConnectionFixture(), id = String(repeating: "c", count: 32)
        native.failClose = true
        let bridge = RecordingLabBridge { _, _, _ in native }
        try await bridge.start(id, activityId: "activity")
        var refused = false
        do { try await bridge.close(id) } catch { refused = true }; try require(refused)
        refused = false
        do { try await bridge.start(String(repeating: "d", count: 32), activityId: "other") } catch { refused = true }
        try require(refused); try require(native.closed == 1)
    }
}
