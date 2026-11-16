import Foundation
#if !BOTA_RECORDING_SPEECH_HOST_CHECKS
import XCTest
@testable import BotaAppSDK
#else
class XCTestCase {}
#endif
private struct RecordingCheckFailure: Error {}
private func recordingTrue(_ value: Bool) throws { if !value { throw RecordingCheckFailure() } }
private func recordingFalse(_ value: Bool) throws { try recordingTrue(!value) }
private func recordingEqual<T: Equatable>(_ actual: T, _ expected: T) throws { try recordingTrue(actual == expected) }

private actor RecordingTransportFixture: RecordingSpeechTransport {
    var sent: [RecordingSpeechMessage] = []
    var waiting: [CheckedContinuation<RecordingSpeechMessage, any Error>] = []
    var messages: [RecordingSpeechMessage] = []
    var closed = false
    var beforeClose: (@Sendable () -> Void)?
    func onClose(_ callback: @escaping @Sendable () -> Void) { beforeClose = callback }
    func send(_ message: RecordingSpeechMessage) async throws { if closed { throw SpeechCaptureFailure.closed }; sent.append(message) }
    func receive() async throws -> RecordingSpeechMessage {
        if !messages.isEmpty { return messages.removeFirst() }
        if closed { throw SpeechCaptureFailure.closed }
        return try await withCheckedThrowingContinuation { waiting.append($0) }
    }
    func offer(_ value: [String: String]) throws { offer(.control(try JSONSerialization.data(withJSONObject: value))) }
    func offer(_ message: RecordingSpeechMessage) {
        if !waiting.isEmpty { waiting.removeFirst().resume(returning: message) } else { messages.append(message) }
    }
    func close() async { beforeClose?(); closed = true; for waiter in waiting { waiter.resume(throwing: SpeechCaptureFailure.closed) }; waiting.removeAll() }
    func audio() -> [Data] { sent.compactMap { if case .audio(let data) = $0 { return data }; return nil } }
}
private final class RecordingPlaybackFixture: RecordingSpeechPlayback, @unchecked Sendable {
    let lock = NSLock(); var clearCount = 0
    func clear() async throws { lock.withLock { clearCount += 1 } }
    func clears() -> Int { lock.withLock { clearCount } }
    func play(_ pcm: Data, outputId: String, offsetSamples: UInt64) -> Bool { true }
    func drain() async throws {}
}
final class RecordingSpeechTests: XCTestCase {
    func testDirectNativeOwnerUsesRustFramesAndJoinsTransportWithoutOwningCapture() async throws {
        let id = "11111111-1111-4111-8111-111111111111", endpoint = "wss://api.example.com/v1/recording-speech/ws"
        let transport = RecordingTransportFixture(), playback = RecordingPlaybackFixture()
        let configuration = try JSONSerialization.data(withJSONObject: ["projectId": "prj_test", "activityId": id, "endpoint": endpoint])
        let grant = try JSONSerialization.data(withJSONObject: ["version": 1, "project_id": "prj_test", "activity_id": id, "transport": "websocket",
            "protocol": "bota.recording-speech.v1", "url": endpoint, "token": String(repeating: "a", count: 43), "generation": 1,
            "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(20))] as [String: Any])
        let session = try RecordingSpeechSession(configurationJSON: configuration, grantJSON: grant, playback: playback, transportFactory: { _, _ in transport })
        let ready = try JSONSerialization.data(withJSONObject: ["type": "ready", "version": 1, "activityId": id, "generation": 1,
            "target": ["revision": 1, "language": "zh"], "sources": [["id": "mixed", "epoch": 1, "role": "mixed", "speaker": "unknown", "language": "en", "startSample": 0]],
            "input": ["format": "pcm_s16le", "sampleRate": 48000, "maxFrameSamples": 4800], "playbackRoute": "unqualified"] as [String: Any])
        await transport.offer(.control(ready)); try await session.ready(); try await session.setRoute(headphones: true)
        try recordingTrue(session.offer(sourceIndex: 0, firstSample: 0, pcm: Data([1, 0, 2, 0])))
        for _ in 0..<100 { if !(await transport.audio()).isEmpty { break }; try await Task.sleep(for: .milliseconds(5)) }
        let frames = await transport.audio(); try recordingEqual(frames.count, 1)
        try recordingEqual(frames.first?.prefix(4), Data("BRS1".utf8)); try recordingEqual(frames.first?.suffix(4), Data([1, 0, 2, 0]))
        let before = playback.clears()
        let clearedFirst = RecordingPlaybackFixture()
        await transport.onClose { if playback.clears() > before { clearedFirst.lock.withLock { clearedFirst.clearCount = 1 } } }
        try await session.close(); try await session.close()
        try recordingEqual(clearedFirst.clears(), 1)
        try recordingFalse(session.offer(sourceIndex: 0, firstSample: 2, pcm: Data([3, 0])))
        let closed = await transport.closed; try recordingTrue(closed)
    }
}
