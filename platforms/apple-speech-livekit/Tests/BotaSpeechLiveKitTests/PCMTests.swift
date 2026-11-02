import AVFAudio
import BotaAppSDK
@testable import BotaSpeechLiveKit
import Foundation

private final class TestPlayer: PCMPlayer, @unchecked Sendable {
    private let lock = NSLock()
    private var completions: [@Sendable () -> Void] = []
    let scheduled = Gate()
    let closed = Gate()
    func schedule(_ frame: PCMFrame, played: @escaping @Sendable () -> Void) throws {
        lock.withLock { completions.append(played) }; scheduled.open()
    }
    func mute() {}
    func close() throws { closed.open() }
    func finish() {
        let pending = lock.withLock { defer { completions.removeAll() }; return completions }
        pending.forEach { $0() }
    }
}

private final class PlayerFactory: @unchecked Sendable {
    private let lock = NSLock()
    private var players: [TestPlayer] = []
    let first = TestPlayer()
    let second = TestPlayer()
    var count: Int { lock.withLock { players.count } }
    func make(_ frame: PCMFrame) -> any PCMPlayer {
        lock.withLock { let player = players.isEmpty ? first : second; players.append(player); return player }
    }
}

final class PCMChecks: @unchecked Sendable {
    private func frame(_ frames: AVAudioFrameCount = 800) throws -> PCMFrame {
        let format = AVAudioFormat(standardFormatWithSampleRate: 8000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        buffer.frameLength = frames
        buffer.floatChannelData![0].initialize(repeating: 0.25, count: Int(frames))
        return try PCMFrame.copy(buffer)
    }

    func testUnknownAndClearedFramesCannotReachTheDevice() async throws {
        let factory = PlayerFactory()
        let output = ApplePCMOutput(failed: {}, factory: { factory.make($0) })
        output.frame("unknown", try frame())
        try await output.clear()
        try require(factory.count == 0)
        try output.select(["one"]); try await output.clear()
        output.frame("one", try frame())
        try await output.close()
        try require(factory.count == 0)
    }

    func testSilencedSidCannotReuseItsOldDeviceBuffers() async throws {
        let factory = PlayerFactory()
        let output = ApplePCMOutput(failed: {}, factory: { factory.make($0) })
        try output.select(["one"]); output.frame("one", try frame())
        try await factory.first.scheduled.wait()
        try output.silence(); try output.select(["one"])
        try await factory.first.closed.wait()
        output.frame("one", try frame()); try await factory.second.scheduled.wait()
        try require(factory.count == 2)
        factory.second.finish(); try await output.drain("one"); try await output.close()
    }

    func testUnplayedFramesRemainBoundedByTheQueueBudget() async throws {
        let factory = PlayerFactory(); let blocked = Gate()
        let output = ApplePCMOutput(failed: { blocked.open() }, factory: { factory.make($0) })
        try output.select(["one"])
        for _ in 0..<3 { output.frame("one", try frame()) }
        try await blocked.wait(); try await output.close()
        try require(factory.count <= 1)
    }

    func testDrainRequiresThePlayedCallbackAndClearRetiresIt() async throws {
        let factory = PlayerFactory()
        let output = ApplePCMOutput(failed: {}, factory: { factory.make($0) })
        try output.select(["one"]); output.frame("one", try frame())
        try await factory.first.scheduled.wait()
        var error: SpeechError?
        do { try await output.drain("one") } catch let failure { error = failure as? SpeechError }
        try require(error == .playbackBlocked, "Enqueue completion is not audible completion")
        try await output.clear(); try await output.drain("one"); try await output.close()
    }

    func testBorrowedNativeBuffersAreCopiedBeforeReturning() async throws {
        let original = try frame(80)
        let owned = try PCMFrame.copy(original.buffer)
        original.buffer.floatChannelData![0][0] = 0.75
        try require(owned.buffer.floatChannelData![0][0] == 0.25)
    }

    func testRetiredTrackCannotConsumeTheNextSelectionBudget() async throws {
        let factory = PlayerFactory()
        let output = ApplePCMOutput(failed: {}, factory: { factory.make($0) })
        try output.select(["one"]); output.frame("one", try frame())
        try await factory.first.scheduled.wait()
        try output.select(["two"])
        output.frame("two", try frame()); output.frame("two", try frame())
        try await factory.second.scheduled.wait()
        try await output.close()
    }
}
