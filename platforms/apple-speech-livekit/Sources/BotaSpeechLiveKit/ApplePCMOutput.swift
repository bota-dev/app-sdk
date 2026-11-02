import AVFAudio
import BotaAppSDK
import Foundation

protocol PCMPlayer: Sendable {
    func schedule(_ frame: PCMFrame, played: @escaping @Sendable () -> Void) throws
    func mute()
    func close() throws
}

/// Reservations include queued work and device playback; producer speed cannot grow latency without a bound.
final class ApplePCMOutput: PCMOutput, @unchecked Sendable {
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "dev.bota.speech.pcm")
    private let failed: @Sendable () -> Void
    private let factory: @Sendable (PCMFrame) throws -> any PCMPlayer
    private struct Pending { let sid: String; let duration: Double }
    private var pending: [UUID: Pending] = [:]
    private var players: [String: any PCMPlayer] = [:]
    private var selected = Set<String>()
    private var epoch: UInt64 = 0
    private var closed = false
    private var cleanupFailed = false
    private var seconds = 0.0

    init(failed: @escaping @Sendable () -> Void,
         factory: @escaping @Sendable (PCMFrame) throws -> any PCMPlayer = { try NativePCMPlayer($0) }) {
        self.failed = failed; self.factory = factory
    }

    private func silenceLocked() {
        epoch &+= 1; selected = []; pending.removeAll(); seconds = 0
        players.values.forEach { $0.mute() }
    }
    func silence() throws { lock.withLock { silenceLocked() } }

    func select(_ sids: Set<String>) throws {
        try lock.withLock {
            guard !closed, sids.count <= 16 else { throw SpeechError.mediaFailed }
            // Empty selection retires players; subsequent admission cannot replay muted old buffers.
            let retiring = Set(players.keys).subtracting(selected.intersection(sids))
            for sid in retiring {
                do { try players[sid]?.close(); players[sid] = nil }
                catch { cleanupFailed = true; throw SpeechError.cleanupFailed }
            }
            for id in pending.keys.filter({ !sids.contains(pending[$0]!.sid) }) {
                if let retired = pending.removeValue(forKey: id) { seconds = max(0, seconds - retired.duration) }
            }
            selected = sids
        }
    }

    func frame(_ sid: String, _ frame: PCMFrame) {
        let duration = frame.duration
        let admission = lock.withLock { () -> (UUID, UInt64)? in
            guard !closed, selected.contains(sid) else { return nil }
            guard duration.isFinite, duration > 0, duration <= 0.100_001,
                  seconds + duration <= 0.200_001, pending.count < 64 else {
                silenceLocked()
                queue.async { self.failed() }
                return nil
            }
            let id = UUID(); pending[id] = Pending(sid: sid, duration: duration); seconds += duration
            return (id, epoch)
        }
        guard let (id, generation) = admission else { return }
        queue.async { [self] in
            var report = false
            lock.withLock {
                guard !closed, epoch == generation, selected.contains(sid), pending[id] != nil else { return }
                do {
                    let player: any PCMPlayer
                    if let existing = players[sid] { player = existing }
                    else { player = try factory(frame); players[sid] = player }
                    try player.schedule(frame) { [weak self] in
                        // stop() may complete scheduled buffers synchronously; never reenter the output lock.
                        guard let self else { return }
                        self.queue.async { self.complete(id, generation: generation) }
                    }
                } catch { silenceLocked(); report = true }
            }
            if report { failed() }
        }
    }

    private func complete(_ id: UUID, generation: UInt64) {
        lock.withLock {
            guard generation == epoch, let value = pending.removeValue(forKey: id) else { return }
            seconds = max(0, seconds - value.duration)
        }
    }

    func clear() async throws {
        try silence()
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, any Error>) in
            queue.async { [self] in
                let failed = lock.withLock {
                    for sid in Array(players.keys) {
                        do { try players[sid]?.close(); players[sid] = nil }
                        catch { cleanupFailed = true }
                    }
                    return cleanupFailed
                }
                if failed { done.resume(throwing: SpeechError.cleanupFailed) } else { done.resume() }
            }
        }
    }

    func drain(_ sid: String) async throws {
        let generation = lock.withLock { epoch }
        let deadline = ProcessInfo.processInfo.systemUptime + 1
        while lock.withLock({ !closed && epoch == generation && selected.contains(sid) && pending.values.contains { $0.sid == sid } }) {
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw SpeechError.playbackBlocked }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    func close() async throws {
        lock.withLock { closed = true }
        try await clear()
    }
}

private final class NativePCMPlayer: PCMPlayer, @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private let format: AVAudioFormat

    init(_ first: PCMFrame) throws {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: first.buffer.format.sampleRate,
                                         channels: first.buffer.format.channelCount) else { throw SpeechError.mediaFailed }
        self.format = format
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        do { try engine.start() }
        catch { node.stop(); engine.stop(); engine.reset(); throw SpeechError.mediaFailed }
    }
    func schedule(_ frame: PCMFrame, played: @escaping @Sendable () -> Void) throws {
        guard frame.buffer.format.sampleRate == format.sampleRate,
              frame.buffer.format.channelCount == format.channelCount,
              let converter = AVAudioConverter(from: frame.buffer.format, to: format),
              let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frame.buffer.frameLength) else {
            throw SpeechError.mediaFailed
        }
        try converter.convert(to: converted, from: frame.buffer)
        node.scheduleBuffer(converted, completionCallbackType: .dataPlayedBack) { _ in played() }
        if !node.isPlaying { node.play() }
    }
    func mute() { node.volume = 0 }
    func close() throws {
        node.volume = 0; node.stop(); node.reset(); engine.stop(); engine.reset()
    }
}
