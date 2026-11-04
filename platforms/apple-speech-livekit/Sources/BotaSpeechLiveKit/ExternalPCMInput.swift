import AVFAudio
import BotaAppSDK
import Foundation
import LiveKit

/// One authorized participant's original native PCM branch. The host owns consent, source mute/end,
/// format conversion and its conference audio session. This object never changes the host track.
public final class ExternalPCMInput: @unchecked Sendable {
    private let participantId: String
    private let memberGeneration: UInt32
    private let now: @Sendable () -> UInt64
    private let lock = NSLock()
    private struct Frame { let samples: [Int16]; let offeredAt: UInt64 }
    private var queue: [Frame] = []
    private var offset = 0
    private var attached = false
    private var validated = false
    private var capturing = false
    private var muted = true
    private var terminal = false
    private var failed: (@Sendable () -> Void)?

    public convenience init(participantId: String, memberGeneration: UInt32) throws {
        try self.init(participantId: participantId, memberGeneration: memberGeneration,
                      now: { DispatchTime.now().uptimeNanoseconds })
    }

    init(participantId: String, memberGeneration: UInt32, now: @escaping @Sendable () -> UInt64) throws {
        guard !participantId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              participantId.utf8.count <= 128, memberGeneration > 0 else { throw SpeechError.invalidInput }
        self.participantId = participantId; self.memberGeneration = memberGeneration; self.now = now
    }

    func requireAvailable() throws {
        try lock.withLock { guard !attached, !terminal else { throw SpeechError.invalidInput } }
    }

    func attach(_ report: @escaping @Sendable () -> Void) throws {
        try lock.withLock {
            guard !attached, !terminal else { throw SpeechError.invalidInput }
            attached = true; failed = report
        }
    }

    func validate(_ grant: SpeechGrant) throws {
        try lock.withLock {
            guard !terminal, attached, participantId == grant.participantId,
                  memberGeneration == grant.memberGeneration else { throw SpeechError.invalidInput }
            validated = true
        }
    }

    func capture(_ enabled: Bool) {
        lock.withLock { capturing = enabled && !terminal; if !capturing { queue.removeAll(); offset = 0 } }
    }

    /// Forward every host mute change. Unmuting cannot override an SDK hold.
    public func setMuted(_ muted: Bool) {
        lock.withLock { self.muted = muted; if muted { queue.removeAll(); offset = 0 } }
    }

    /// Copies exactly 480 mono PCM16 samples at 48 kHz (10 ms). False means no audio was accepted.
    /// Starts muted. Invalid, stale or overflowing input retires the branch; inactive input is discarded.
    /// Never supply generated translation or mixed conference audio.
    @discardableResult
    public func offer(_ pcm: AVAudioPCMBuffer) -> Bool {
        var report: (@Sendable () -> Void)?
        let accepted = lock.withLock {
            guard !terminal, validated, capturing, !muted else { return false }
            let time = now(); let format = pcm.format
            guard format.sampleRate == 48000, format.channelCount == 1,
                  format.commonFormat == .pcmFormatInt16, pcm.frameLength == 480,
                  pcm.audioBufferList.pointee.mBuffers.mDataByteSize >= 960,
                  let samples = pcm.int16ChannelData, queue.count < 20, !stale(time) else {
                report = failLocked(); return false
            }
            queue.append(Frame(samples: Array(UnsafeBufferPointer(start: samples[0], count: 480)), offeredAt: time))
            return true
        }
        report?(); return accepted
    }

    /// Unexpected source loss fails the media session. Use SpeechSession.finishInput for normal completion.
    public func end() { let report = lock.withLock { failLocked() }; report?() }

    /// Native microphone fork. Copies the same 480 PCM16LE samples used by the
    /// independent archive; no audio crosses an application-language bridge.
    @discardableResult public func offer(pcm16LE: Data) -> Bool {
        var report: (@Sendable () -> Void)?
        let accepted = lock.withLock {
            guard !terminal, validated, capturing, !muted else { return false }
            let time = now()
            guard pcm16LE.count == 960, queue.count < 20, !stale(time) else { report = failLocked(); return false }
            let samples = pcm16LE.withUnsafeBytes { bytes in
                (0..<480).map { Int16(littleEndian: bytes.loadUnaligned(fromByteOffset: $0 * 2, as: Int16.self)) }
            }
            queue.append(Frame(samples: samples, offeredAt: time)); return true
        }
        report?(); return accepted
    }

    /// Join local render consumption after the physical source stops. This is
    /// separate from the worker's source-finish acknowledgement and RTP delivery.
    public func drain() async -> Bool {
        let until = DispatchTime.now().uptimeNanoseconds + 250_000_000
        while DispatchTime.now().uptimeNanoseconds < until {
            let result: Bool? = lock.withLock {
                if terminal || !capturing || muted { return false }
                return queue.isEmpty ? true : nil
            }
            if let result { return result }
            do { try await Task.sleep(nanoseconds: 5_000_000) } catch { return false }
        }
        return false
    }

    func retire() { lock.withLock { terminal = true; capturing = false; queue.removeAll(); offset = 0; failed = nil } }

    private func stale(_ time: UInt64) -> Bool {
        guard let first = queue.first else { return false }
        return time < first.offeredAt || time - first.offeredAt > 200_000_000
    }

    private func failLocked() -> (@Sendable () -> Void)? {
        guard !terminal else { return nil }
        terminal = true; capturing = false; queue.removeAll(); offset = 0
        defer { failed = nil }; return failed
    }

    func nativeReleased() {
        let report = lock.withLock {
            queue.removeAll(); offset = 0
            return capturing ? failLocked() : nil
        }
        report?()
    }

    /// Copies normalized Float PCM into the native source node, including partial frame reads.
    func render(frames: Int, channels: Int, channel: (Int) -> UnsafeMutablePointer<Float>) {
        var report: (@Sendable () -> Void)?
        lock.withLock {
            for index in 0..<channels { channel(index).update(repeating: 0, count: frames) }
            guard !terminal, validated, capturing, !muted else { return }
            guard (1...4800).contains(frames), channels == 1, !stale(now()) else {
                report = failLocked(); return
            }
            var written = 0
            let target = channel(0)
            while written < frames, let frame = queue.first {
                let count = min(frames - written, 480 - offset)
                for sample in 0..<count { target[written + sample] = Float(frame.samples[offset + sample]) / 32768 }
                written += count; offset += count
                if offset == 480 { queue.removeFirst(); offset = 0 }
            }
        }
        report?()
    }
}

/// The no-device engine pulls admitted audio directly, without scheduling mixer/player buffers.
final class ExternalPCMSource: AudioEngineObserver, @unchecked Sendable {
    var next: (any AudioEngineObserver)?
    private let input: ExternalPCMInput
    private let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    init(_ input: ExternalPCMInput) { self.input = input }
    lazy var source = AVAudioSourceNode(format: format) { [input] _, _, frames, list in
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        guard buffers.count == 1, let data = buffers[0].mData,
              buffers[0].mDataByteSize >= frames * 4 else {
            for buffer in buffers {
                if let data = buffer.mData { data.initializeMemory(as: UInt8.self, repeating: 0, count: Int(buffer.mDataByteSize)) }
            }
            input.end(); return 0
        }
        input.render(frames: Int(frames), channels: 1, channel: { _ in data.assumingMemoryBound(to: Float.self) })
        return 0
    }
    func engineDidCreate(_ engine: AVAudioEngine) -> Int { engine.attach(source); return 0 }
    func engineWillRelease(_ engine: AVAudioEngine) -> Int { engine.detach(source); input.nativeReleased(); return 0 }
    func engineWillConnectInput(_ engine: AVAudioEngine, src: AVAudioNode?, dst: AVAudioNode,
                               format: AVAudioFormat, context: [AnyHashable: Any]) -> Int {
        guard engine.isInManualRenderingMode else { return -1 }
        engine.connect(source, to: dst, format: self.format)
        return 0
    }
    func engineWillStart(_ engine: AVAudioEngine, isPlayoutEnabled: Bool, isRecordingEnabled: Bool) -> Int {
        let mixer = AudioManager.shared.mixer
        // In no-device mode the main mixer carries outgoing input, never audible remote playback.
        mixer.outputVolume = 1; engine.mainMixerNode.outputVolume = 1
        mixer.micVolume = 0; mixer.appVolume = 0; mixer.soundPlayerVolume = 0
        return 0
    }
}
