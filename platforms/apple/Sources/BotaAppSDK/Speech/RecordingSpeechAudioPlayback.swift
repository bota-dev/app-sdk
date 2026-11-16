import AVFAudio
import Foundation

/// Bounded volatile output on an App-qualified headphone route. The App owns
/// audio-session category/focus and route qualification. Route changes clear
/// scheduled audio immediately; a new route requires explicit qualification.
public final class RecordingSpeechAudioPlayback: RecordingSpeechPlayback, @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format: AVAudioFormat
    private let headphoneRoute: @Sendable () -> Bool
    private let routeLost: @Sendable () -> Void
    private var qualified: Bool
    private var closed = false
    private var samples = 0
    private var buffers: [UUID: AVAudioPCMBuffer] = [:]
    private var observers: [any NSObjectProtocol] = []
    public init(headphoneRoute: @escaping @Sendable () -> Bool, onRouteLost: @escaping @Sendable () -> Void = {}) throws {
        self.headphoneRoute = headphoneRoute; routeLost = onRouteLost; qualified = headphoneRoute()
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false) else {
            throw SpeechCaptureFailure.unavailable
        }
        self.format = format
        engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: format)
        engine.prepare(); try engine.start(); player.play()
        observers.append(NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange,
            object: engine, queue: nil) { [weak self] _ in self?.invalidateRoute() })
        #if os(iOS)
        for name in [AVAudioSession.routeChangeNotification, AVAudioSession.interruptionNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in self?.invalidateRoute() })
        }
        #endif
    }
    private func erase(_ buffer: AVAudioPCMBuffer) {
        buffer.floatChannelData?[0].update(repeating: 0, count: Int(buffer.frameLength))
    }
    private func clearLocked() {
        player.stop()
        for buffer in buffers.values { erase(buffer) }
        buffers.removeAll(); samples = 0
        if !closed && engine.isRunning { player.play() }
    }
    private func invalidateRoute() {
        lock.withLock { qualified = false; clearLocked() }
        routeLost()
    }
    @discardableResult public func qualifyHeadphones() throws -> Bool {
        try lock.withLock {
            guard !closed else { throw SpeechCaptureFailure.closed }
            qualified = headphoneRoute()
            if !qualified { clearLocked() }
            if qualified && !engine.isRunning { try engine.start(); player.play() }
            return qualified
        }
    }
    public func play(_ pcm: Data, outputId: String, offsetSamples: UInt64) -> Bool {
        lock.withLock {
            if !closed && qualified && !headphoneRoute() { qualified = false; clearLocked(); routeLost() }
            guard !closed, qualified, engine.isRunning,
                  !pcm.isEmpty, pcm.count.isMultiple(of: 2), pcm.count <= 48000, samples + pcm.count / 2 <= 24000,
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(pcm.count / 2)),
                  let channel = buffer.floatChannelData?[0] else { return false }
            buffer.frameLength = buffer.frameCapacity
            pcm.withUnsafeBytes { bytes in
                for index in 0..<Int(buffer.frameLength) {
                    channel[index] = Float(Int16(littleEndian: bytes.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))) / 32768
                }
            }
            let id = UUID(); buffers[id] = buffer; samples += Int(buffer.frameLength)
            player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                self?.lock.withLock {
                    guard let self, let completed = self.buffers.removeValue(forKey: id) else { return }
                    self.samples -= Int(completed.frameLength); self.erase(completed)
                }
            }
            return true
        }
    }
    public func clear() async throws { lock.withLock { if !closed { clearLocked() } } }
    public func drain() async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 2
        while lock.withLock({ !closed && samples > 0 }) {
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw SpeechCaptureFailure.unavailable }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }
    public func close() {
        lock.withLock {
            guard !closed else { return }
            closed = true; qualified = false; clearLocked(); engine.stop()
            observers.forEach { NotificationCenter.default.removeObserver($0) }; observers.removeAll()
        }
    }
    deinit { close() }
}
