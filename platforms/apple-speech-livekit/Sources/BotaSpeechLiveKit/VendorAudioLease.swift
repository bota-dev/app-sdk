import BotaAppSDK
import Foundation
import LiveKit

private struct QuietLogger: Logger {
    func log(_ message: @autoclosure () -> any CustomStringConvertible, _ level: LogLevel,
             source: @autoclosure () -> String?, file: StaticString, type: Any.Type,
             function: StaticString, line: UInt, metaData: ScopedMetadataContainer) {}
}

/// The App reserves the process-wide LiveKit audio engine before creating either input adapter.
final class VendorAudioLease: @unchecked Sendable {
    private final class Reservation: @unchecked Sendable {
        let lock = NSLock()
        var held = false
    }
    private static let reservation = Reservation()
    private let original: (Float, Float, Float, Float)
    private let source: ExternalPCMSource?
    private init(_ original: (Float, Float, Float, Float), source: ExternalPCMSource?) {
        self.original = original; self.source = source
    }

    static func acquire(externalInput: ExternalPCMInput? = nil) throws -> VendorAudioLease {
        try reservation.lock.withLock {
            guard !reservation.held else { throw SpeechError.mediaFailed }
            LiveKitSDK.setLogger(QuietLogger())
            let audio = AudioManager.shared
            guard !audio.isEngineRunning, !audio.isRecordingAlwaysPreparedMode, !audio.isManualRenderingMode else {
                throw SpeechError.mediaFailed
            }
            if externalInput != nil, audio.capturePostProcessingDelegate != nil || audio.mixer.next != nil { throw SpeechError.mediaFailed }
            let mixer = audio.mixer
            let source = externalInput.map { ExternalPCMSource($0) }
            let lease = VendorAudioLease((mixer.outputVolume, mixer.micVolume, mixer.appVolume, mixer.soundPlayerVolume), source: source)
            reservation.held = true
            mixer.outputVolume = 0; mixer.micVolume = 0; mixer.appVolume = 0; mixer.soundPlayerVolume = 0
            if let source {
                // No-device mode preserves the host's AVAudioSession and never requests microphone access.
                // Retain the reservation if the native mode transition fails after ownership changes.
                try audio.setManualRenderingMode(true)
                audio.mixer.next = source
                mixer.outputVolume = 1
            }
            return lease
        }
    }

    func release() throws {
        try Self.reservation.lock.withLock {
            let audio = AudioManager.shared; let mixer = audio.mixer
            // AVAudioEngine detaching the input mixers resets their native gains to one.
            // A stopped engine proves retirement; those reset gains cannot prove ownership loss.
            guard !audio.isEngineRunning, !audio.isRecordingAlwaysPreparedMode,
                  mixer.outputVolume == (source == nil ? 0 : 1) else { throw SpeechError.cleanupFailed }
            if let source {
                guard audio.isManualRenderingMode, audio.capturePostProcessingDelegate == nil,
                      (mixer.next as? ExternalPCMSource) === source else { throw SpeechError.cleanupFailed }
                mixer.next = nil
                try audio.setManualRenderingMode(false)
            } else if audio.isManualRenderingMode { throw SpeechError.cleanupFailed }
            mixer.outputVolume = original.0; mixer.micVolume = original.1
            mixer.appVolume = original.2; mixer.soundPlayerVolume = original.3
            Self.reservation.held = false
        }
    }
}
