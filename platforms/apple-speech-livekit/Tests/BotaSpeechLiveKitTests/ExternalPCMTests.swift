import AVFAudio
import BotaAppSDK
@testable import BotaSpeechLiveKit
import Foundation
import LiveKit

private final class ExternalClock: @unchecked Sendable {
    private let lock = NSLock()
    private var time: UInt64 = 0
    func read() -> UInt64 { lock.withLock { time } }
    func advance() { lock.withLock { time = 201_000_000 } }
}

private final class ExternalRenderer: NSObject, AudioRenderer, @unchecked Sendable {
    let received = Gate()
    let started = Gate()
    private let lock = NSLock()
    private var metadata = "no callback"
    var diagnostic: String { lock.withLock { metadata } }
    func render(pcmBuffer: AVAudioPCMBuffer) {
        lock.withLock { metadata = "frames=\(pcmBuffer.frameLength) rate=\(pcmBuffer.format.sampleRate)" }
        started.open()
        if pcmBuffer.format.sampleRate == 48000, let samples = pcmBuffer.floatChannelData,
           (0..<Int(pcmBuffer.frameLength)).contains(where: { abs(samples[0][$0] - 1234.0 / 32768) < 0.00001 }) { received.open() }
    }
}

final class ExternalChecks: @unchecked Sendable {
    private let grant = SpeechGrant(protocolVersion: 1, provider: "livekit", url: "wss://example.invalid",
        room: "room", identity: "listener", token: "redacted", expiresAt: "2099-01-01T00:00:00Z",
        sessionId: "session", participantId: "participant", memberGeneration: 1, workerGeneration: 1,
        processorIdentity: "processor")
    private func frame(_ value: Int16 = 1234, count: AVAudioFrameCount = 480, sampleRate: Double = 48000) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: false)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count)!
        buffer.frameLength = count
        buffer.int16ChannelData![0].initialize(repeating: value, count: Int(count))
        return buffer
    }
    private func start(_ input: ExternalPCMInput, failure: @escaping @Sendable () -> Void = {}) throws {
        try input.attach(failure); try input.validate(grant); input.capture(true); input.setMuted(false)
    }
    private func read(_ input: ExternalPCMInput, frames: Int = 480) -> [Float] {
        var result = [Float](repeating: 999, count: frames)
        result.withUnsafeMutableBufferPointer { buffer in
            input.render(frames: frames, channels: 1, channel: { _ in buffer.baseAddress! })
        }
        return result
    }

    func testExternalInputCopiesBorrowedFramesAndStartsSilent() async throws {
        let input = try ExternalPCMInput(participantId: "participant", memberGeneration: 1)
        try require(read(input, frames: 160).allSatisfy { $0 == 0 })
        try require(!input.offer(frame()))
        try input.attach {}; try input.validate(grant); input.capture(true)
        try require(!input.offer(frame())); input.setMuted(false)
        let borrowed = frame(); try require(input.offer(borrowed))
        borrowed.int16ChannelData![0][0] = 30000
        try require(read(input) == [Float](repeating: 1234.0 / 32768, count: 480))
        try require(read(input).allSatisfy { $0 == 0 })
    }

    func testExternalMuteAndHoldCannotReplayQueuedSpeech() async throws {
        let input = try ExternalPCMInput(participantId: "participant", memberGeneration: 1); try start(input)
        try require(input.offer(frame())); input.setMuted(true); input.setMuted(false)
        try require(read(input).allSatisfy { $0 == 0 })
        try require(input.offer(frame())); input.capture(false); input.setMuted(false)
        try require(!input.offer(frame())); input.capture(true)
        try require(read(input).allSatisfy { $0 == 0 })
        try require(input.offer(frame()))
        try require(read(input, frames: 160) == [Float](repeating: 1234.0 / 32768, count: 160))
        input.setMuted(true); input.setMuted(false)
        try require(input.offer(frame(2345)))
        try require(read(input) == [Float](repeating: 2345.0 / 32768, count: 480))
    }

    func testExternalOverflowAndStaleAudioAreTerminal() async throws {
        let failed = Gate(); let clock = ExternalClock()
        let input = try ExternalPCMInput(participantId: "participant", memberGeneration: 1, now: { clock.read() })
        try start(input) { failed.open() }
        for _ in 0..<20 { try require(input.offer(frame())) }
        try require(!input.offer(frame())); try require(failed.isOpen)
        try require(read(input).allSatisfy { $0 == 0 })
        let stale = try ExternalPCMInput(participantId: "participant", memberGeneration: 1, now: { clock.read() })
        let expired = Gate(); try start(stale) { expired.open() }
        try require(stale.offer(frame())); clock.advance()
        try require(read(stale).allSatisfy { $0 == 0 }); try require(expired.isOpen)
    }

    func testExternalInvalidFormatAndNativeRateFailClosed() async throws {
        let invalid = Gate(); let input = try ExternalPCMInput(participantId: "participant", memberGeneration: 1)
        try start(input) { invalid.open() }; try require(!input.offer(frame(count: 481)))
        try require(invalid.isOpen)
        let rate = Gate(); let other = try ExternalPCMInput(participantId: "participant", memberGeneration: 1)
        try start(other) { rate.open() }; try require(!other.offer(frame(count: 160, sampleRate: 16000)))
        try require(rate.isOpen); try require(read(other).allSatisfy { $0 == 0 })
        let size = Gate(); let third = try ExternalPCMInput(participantId: "participant", memberGeneration: 1)
        try start(third) { size.open() }; try require(third.offer(frame()))
        try require(read(third, frames: 4801).allSatisfy { $0 == 0 }); try require(size.isOpen)
    }

    func testExternalBindingAndDuplicateOwnershipAreRejected() async throws {
        let input = try ExternalPCMInput(participantId: "other", memberGeneration: 1); try input.attach {}
        do { try input.validate(grant); throw CheckFailure(message: "foreign grant accepted") } catch SpeechError.invalidInput {}
        input.capture(true); input.setMuted(false); try require(!input.offer(frame()))
        do { try input.attach {}; throw CheckFailure(message: "duplicate owner accepted") } catch SpeechError.invalidInput {}
        let stale = try ExternalPCMInput(participantId: "participant", memberGeneration: 2); try stale.attach {}
        do { try stale.validate(grant); throw CheckFailure(message: "stale grant accepted") } catch SpeechError.invalidInput {}
    }

    func testExternalEndAndCloseFenceLateFrames() async throws {
        let failed = Gate(); let input = try ExternalPCMInput(participantId: "participant", memberGeneration: 1)
        try start(input) { failed.open() }; try require(input.offer(frame()))
        input.end(); try require(failed.isOpen); input.capture(true); input.setMuted(false)
        try require(!input.offer(frame())); try require(read(input).allSatisfy { $0 == 0 })
        let quiet = Gate(); let closed = try ExternalPCMInput(participantId: "participant", memberGeneration: 1)
        try start(closed) { quiet.open() }; closed.retire(); closed.end()
        try require(!quiet.isOpen); try require(!closed.offer(frame()))
        let released = Gate(); let native = try ExternalPCMInput(participantId: "participant", memberGeneration: 1)
        try start(native) { released.open() }; native.nativeReleased()
        try require(released.isOpen); try require(!native.offer(frame()))
    }

    func testExternalMediaBindingFailsBeforeConnection() async throws {
        let source = try ExternalPCMInput(participantId: "other", memberGeneration: 1)
        let room = FakeRoom()
        let media = try LiveKitSpeechMedia(room: room, output: FakeOutput(), callbacks: Notices().callbacks, externalInput: source)
        do { try await media.connect(grant: grant); throw CheckFailure(message: "foreign grant connected") } catch SpeechError.invalidInput {}
        try require(!room.connected.isOpen); try await media.close()
    }

    func testExternalMediaEndAndCloseRetireInput() async throws {
        let source = try ExternalPCMInput(participantId: "participant", memberGeneration: 1)
        let room = FakeRoom(); let notices = Notices()
        let media = try LiveKitSpeechMedia(room: room, output: FakeOutput(), callbacks: notices.callbacks, externalInput: source)
        try await media.connect(grant: grant); try await media.setInput(enabled: true)
        source.setMuted(false); source.capture(true); source.end()
        try await notices.failed.wait(); try require(!room.captureEnabled)
        try await media.close(); try require(!source.offer(frame()))
    }

    func testExternalFactoryRestoresTheActualVendorAudioOwner() async throws {
        let audio = AudioManager.shared
        try require(!audio.isEngineRunning && !audio.isManualRenderingMode && audio.capturePostProcessingDelegate == nil)
        let mixer = audio.mixer
        let before = [mixer.outputVolume, mixer.micVolume, mixer.appVolume, mixer.soundPlayerVolume]
        let input = try ExternalPCMInput(participantId: "participant", memberGeneration: 1)
        let media = try LiveKitSpeechMedia.createExternal(callbacks: Notices().callbacks, input: input)
        try require(audio.isManualRenderingMode && !audio.isEngineRunning)
        try require(audio.capturePostProcessingDelegate == nil && audio.mixer.next is ExternalPCMSource)
        try require([mixer.outputVolume, mixer.micVolume, mixer.appVolume, mixer.soundPlayerVolume] == [1, 0, 0, 0])
        let other = try ExternalPCMInput(participantId: "other", memberGeneration: 1)
        do {
            _ = try LiveKitSpeechMedia.createExternal(callbacks: Notices().callbacks, input: other)
            throw CheckFailure(message: "second engine owner admitted")
        } catch SpeechError.mediaFailed {}
        try await media.close()
        try require(!audio.isManualRenderingMode && !audio.isEngineRunning && audio.capturePostProcessingDelegate == nil)
        try require([mixer.outputVolume, mixer.micVolume, mixer.appVolume, mixer.soundPlayerVolume] == before)
        let successor = try LiveKitSpeechMedia.createExternal(callbacks: Notices().callbacks, input: other)
        try await successor.close()
    }

    func testExternalPcmTraversesTheActualNoDeviceCaptureCallback() async throws {
        let input = try ExternalPCMInput(participantId: "participant", memberGeneration: 1)
        let notices = Notices()
        let media = try LiveKitSpeechMedia.createExternal(callbacks: notices.callbacks, input: input)
        let track = await LocalAudioTrack.createTrack(name: "native-input-check", options: .noProcessing)
        let renderer = ExternalRenderer()
        let source = (AudioManager.shared.mixer.next as! ExternalPCMSource).source
        var failure: (any Error)?
        do {
            try await track.start()
            source.installTap(onBus: 0, bufferSize: 480, format: nil) { buffer, _ in renderer.render(pcmBuffer: buffer) }
            try await renderer.started.wait()
            try input.validate(grant); input.capture(true); input.setMuted(false)
            try require(input.offer(frame()))
            try await renderer.received.wait()
            try require(!notices.failed.isOpen)
        } catch { failure = error }
        input.capture(false)
        source.removeTap(onBus: 0)
        try await track.stop()
        do { try await media.close() }
        catch {
            let audio = AudioManager.shared; let mixer = audio.mixer
            throw CheckFailure(message: "Native cleanup: engine=\(audio.isEngineRunning), prepared=\(audio.isRecordingAlwaysPreparedMode), manual=\(audio.isManualRenderingMode), gains=\([mixer.outputVolume, mixer.micVolume, mixer.appVolume, mixer.soundPlayerVolume]), failed=\(notices.failed.isOpen), rendered=\(renderer.diagnostic), earlier=\(String(describing: failure))")
        }
        if let failure { throw CheckFailure(message: "Capture failed=\(notices.failed.isOpen), rendered=\(renderer.diagnostic), earlier=\(failure)") }
    }
}
