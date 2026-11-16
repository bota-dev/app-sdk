import Foundation
import XCTest
@testable import BotaAppSDK

private final class RecordingCaptureTestKeys: SpeechCaptureKeys, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    func read(_ id: String) throws -> Data? { lock.withLock { values[id] } }
    func write(_ id: String, value: Data) throws { lock.withLock { values[id] = value } }
    func delete(_ id: String) throws { _ = lock.withLock { values.removeValue(forKey: id) } }
}
final class RecordingCaptureTests: XCTestCase {
    func testStereoArchiveUsesFramesAndRecoversFullSizeEncryptedChunks() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let capture = UUID().uuidString.lowercased(), clock = UUID().uuidString.lowercased(), keys = RecordingCaptureTestKeys()
        let preparation = try JSONSerialization.data(withJSONObject: ["protocol_version": 2, "profile": "speech_capture_pcm_v2",
            "capture_id": capture, "recording_id": "rec_stereo", "sample_rate": 48000, "channels": 2,
            "channel_layout": [["sourceId": "local", "role": "local"], ["sourceId": "remote", "role": "remote"]],
            "format": "pcm_s16le", "cipher": "AES-256-GCM", "data_key": Data(repeating: 7, count: 32).base64EncodedString(),
            "maximum_chunk_samples": 48000, "upload_until": "2099-01-01T00:00:00Z"] as [String: Any])
        var archive = try SpeechCaptureArchive.create(scope: "stereo", preparation: preparation, directory: root, keys: keys)
        try await archive.beginClock(clock)
        let map = RecordingCaptureMapping(sourceClockId: clock, sourceEpoch: 1, firstSample: 0, samples: 48000, sampleRate: 48000, revision: 1, discontinuity: false)
        try await archive.append(firstSample: 0, pcm: Data(repeating: 7, count: 192000), channels: [map, map])
        try await archive.endClock(samples: 48000); try await archive.close()
        let store = try SpeechCaptureStorage(scope: "stereo", captureId: capture, directory: root)
        let packet = try store.packet(0); XCTAssertTrue((packet?.count ?? 0) > 140000); store.close()
        archive = try SpeechCaptureArchive.recover(scope: "stereo", captureId: capture, directory: root, keys: keys)
        let snapshot = try await archive.snapshot(); XCTAssertEqual(snapshot.archiveSamples, 48000)
        try await archive.close()
    }
}
