import AVFAudio
import Foundation

public enum SpeechCaptureEnd: Sendable { case stopped, authorizationExpired, interrupted }

/// Confined to the microphone's capture lock. Conversion emits canonical bytes
/// once; the caller forks those bytes into RTC frames and the archive pump.
final class SpeechCaptureConversion {
    private let converter: AVAudioConverter
    var inputFormat: AVAudioFormat { converter.inputFormat }
    init(format: AVAudioFormat) throws {
        guard format.sampleRate >= 8000, format.sampleRate <= 192000, format.channelCount > 0,
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 48000, channels: 1, interleaved: false),
              let conversion = AVAudioConverter(from: format, to: target) else { throw SpeechCaptureFailure.unavailable }
        conversion.primeMethod = .none; conversion.downmix = true; converter = conversion
    }
    // AVAudioConverter annotates its synchronous input block Sendable. The lock
    // owns the single borrowed buffer and prevents repeated consumption.
    private final class Input: @unchecked Sendable {
        let lock = NSLock()
        var buffer: AVAudioPCMBuffer?
        init(_ buffer: AVAudioPCMBuffer?) { self.buffer = buffer }
        func take() -> AVAudioPCMBuffer? { lock.withLock { defer { buffer = nil }; return buffer } }
    }
    func convert(_ input: AVAudioPCMBuffer?, final: Bool, consume: (Data) -> Bool) -> Bool {
        let capacity = AVAudioFrameCount(ceil(Double(input?.frameLength ?? 4096) * 48000 / converter.inputFormat.sampleRate) + 64)
        guard capacity <= 48000, let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: capacity) else { return false }
        let source = Input(input)
        for _ in 0..<4 {
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, state in
                if let input = source.take() { state.pointee = .haveData; return input }
                state.pointee = final ? .endOfStream : .noDataNow; return nil
            }
            guard error == nil, status != .error else { return false }
            if output.frameLength > 0 {
                guard let samples = output.int16ChannelData else { return false }
                var bytes = Data(bytes: samples[0], count: Int(output.frameLength) * 2)
                defer { bytes.resetBytes(in: 0..<bytes.count) }
                guard consume(bytes) else { return false }
            }
            if status == .inputRanDry || status == .endOfStream { return true }
        }
        return false
    }
}

/// Foreground microphone owner. The application obtains permission and owns its
/// audio session, category, focus and route. This owner never changes global audio
/// session settings. RTC receives the same canonical PCM as the encrypted archive.
public final class SpeechMicrophoneCapture: @unchecked Sendable {
    private let gate = NSLock()
    private let control = DispatchQueue(label: "dev.bota.speech.capture")
    private let engine = AVAudioEngine()
    private let pump: SpeechCapturePump
    private let rtcFrame: @Sendable (Data) -> Void
    private let ended: @Sendable (SpeechCaptureEnd) -> Void
    private var expiresAt: Date
    private var converter: SpeechCaptureConversion?
    private var nextInput: AVAudioFramePosition?
    private var rtcPartial = Data()
    private var observers: [any NSObjectProtocol] = []
    private var timer: DispatchSourceTimer?
    private var tapped = false
    private var reason: SpeechCaptureEnd?
    private var retirement: Task<Void, any Error>?
    private init(pump: SpeechCapturePump, expiresAt: Date, rtcFrame: @escaping @Sendable (Data) -> Void,
                 ended: @escaping @Sendable (SpeechCaptureEnd) -> Void) {
        self.pump = pump; self.expiresAt = expiresAt; self.rtcFrame = rtcFrame; self.ended = ended
    }
    private final class FailureRelay: @unchecked Sendable {
        let lock = NSLock()
        weak var owner: SpeechMicrophoneCapture?
        func fail() { lock.withLock { owner }?.requestStop(.interrupted) }
    }
    /// Permission and the app-owned recording route must be ready before calling.
    /// rtcFrame borrows exactly 480 mono PCM16LE samples and must return without blocking.
    public static func start(archive: SpeechCaptureArchive, expiresAt: Date,
                             rtcFrame: @escaping @Sendable (Data) -> Void,
                             ended: @escaping @Sendable (SpeechCaptureEnd) -> Void = { _ in }) async throws -> SpeechMicrophoneCapture {
        guard expiresAt > Date() else { throw SpeechCaptureFailure.invalidInput }
        let relay = FailureRelay()
        let pump = try await SpeechCapturePump.start(archive: archive) { relay.fail() }
        let owner = SpeechMicrophoneCapture(pump: pump, expiresAt: expiresAt, rtcFrame: rtcFrame, ended: ended)
        relay.lock.withLock { relay.owner = owner }
        do { try await owner.configure(); return owner }
        catch { try? await owner.interruptAndStop(); throw SpeechCaptureFailure.unavailable }
    }
    private func configure() async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, any Error>) in
            control.async { [self] in
                do {
                    guard gate.withLock({ reason == nil && expiresAt > Date() }) else { throw SpeechCaptureFailure.closed }
                    let input = engine.inputNode
                    #if os(iOS)
                    try input.setVoiceProcessingEnabled(true)
                    #endif
                    let format = input.outputFormat(forBus: 0)
                    converter = try SpeechCaptureConversion(format: format)
                    input.installTap(onBus: 0, bufferSize: 480, format: format) { [weak self] buffer, time in self?.receive(buffer, time) }
                    tapped = true
                    observers.append(NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange,
                        object: engine, queue: nil) { [weak self] _ in self?.requestStop(.interrupted) })
                    #if os(iOS)
                    observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification,
                        object: nil, queue: nil) { [weak self] _ in self?.requestStop(.interrupted) })
                    observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification,
                        object: nil, queue: nil) { [weak self] _ in self?.requestStop(.interrupted) })
                    #endif
                    engine.prepare(); try engine.start()
                    let timer = DispatchSource.makeTimerSource(queue: control)
                    timer.schedule(deadline: .now(), repeating: .milliseconds(100))
                    timer.setEventHandler { [self] in
                        if gate.withLock({ expiresAt <= Date() }) { requestStop(.authorizationExpired) }
                    }
                    self.timer = timer; timer.resume(); done.resume()
                } catch { done.resume(throwing: error) }
            }
        }
    }
    private func receive(_ buffer: AVAudioPCMBuffer, _ time: AVAudioTime) {
        let valid = gate.withLock { () -> Bool in
            guard reason == nil else { return true }
            guard expiresAt > Date() else { return false }
            guard time.isSampleTimeValid, buffer.frameLength > 0, buffer.frameLength <= 19200,
                  nextInput == nil || nextInput == time.sampleTime, let converter,
                  buffer.format == converter.inputFormat else { return false }
            nextInput = time.sampleTime + AVAudioFramePosition(buffer.frameLength)
            return convert(buffer, final: false)
        }
        if !valid { requestStop(gate.withLock { expiresAt <= Date() } ? .authorizationExpired : .interrupted) }
    }
    // The tap and shutdown drain are serialized by gate. No disk or network runs here.
    private func convert(_ input: AVAudioPCMBuffer?, final: Bool) -> Bool {
        guard let converter else { return false }
        return converter.convert(input, final: final) { bytes in
            guard pump.offer(bytes) else { return false }
            rtcPartial.append(bytes)
            while rtcPartial.count >= 960 {
                let frame = rtcPartial.prefix(960)
                rtcFrame(Data(frame)); rtcPartial.resetBytes(in: 0..<960); rtcPartial = Data(rtcPartial.dropFirst(960))
            }
            return true
        }
    }
    /// Only a freshly authenticated grant for this unchanged owner may extend capture.
    public func renew(expiresAt: Date) throws {
        try gate.withLock {
            guard reason == nil, expiresAt > Date() else { throw SpeechCaptureFailure.closed }
            self.expiresAt = expiresAt
        }
    }
    @discardableResult private func requestStop(_ value: SpeechCaptureEnd) -> Task<Void, any Error> {
        gate.withLock {
            if let retirement { return retirement }
            reason = value
            let task = Task { try await self.shutdown(value) }
            retirement = task; return task
        }
    }
    private func shutdown(_ initial: SpeechCaptureEnd) async throws {
        let result: SpeechCaptureEnd = await withCheckedContinuation { done in
            control.async { [self] in
                timer?.cancel(); timer = nil
                observers.forEach { NotificationCenter.default.removeObserver($0) }; observers.removeAll()
                engine.stop()
                if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
                let result = gate.withLock { () -> SpeechCaptureEnd in
                    let result = initial != .interrupted && converter != nil && !convert(nil, final: true) ? SpeechCaptureEnd.interrupted : initial
                    converter = nil; rtcPartial.resetBytes(in: 0..<rtcPartial.count); rtcPartial.removeAll()
                    reason = result; return result
                }
                done.resume(returning: result)
            }
        }
        do { try await pump.stop(endKnown: result != .interrupted); ended(result) }
        catch { ended(.interrupted); throw error }
    }
    /// Joins physical capture and accepted archive writes. HTTP remains independent.
    public func stop() async throws { try await requestStop(.stopped).value }
    /// Call on backgrounding or an app-owned route interruption; never invents a known EOF.
    public func interruptAndStop() async throws { try await requestStop(.interrupted).value }
}
