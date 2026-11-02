import BotaAppSDK
import Foundation
import LiveKit

private struct QuietLogger: Logger {
    func log(_ message: @autoclosure () -> any CustomStringConvertible, _ level: LogLevel,
             source: @autoclosure () -> String?, file: StaticString, type: Any.Type,
             function: StaticString, line: UInt, metaData: ScopedMetadataContainer) {}
}

/// The App reserves the process-wide LiveKit audio engine before creating this microphone adapter.
final class VendorAudioLease: @unchecked Sendable {
    private final class Reservation: @unchecked Sendable {
        let lock = NSLock()
        var held = false
    }
    private static let reservation = Reservation()
    private let original: (Float, Float, Float, Float)
    private init(_ original: (Float, Float, Float, Float)) { self.original = original }

    static func acquire() throws -> VendorAudioLease {
        try reservation.lock.withLock {
            guard !reservation.held else { throw SpeechError.mediaFailed }
            LiveKitSDK.setLogger(QuietLogger())
            let audio = AudioManager.shared
            guard !audio.isEngineRunning, !audio.isRecordingAlwaysPreparedMode, !audio.isManualRenderingMode else {
                throw SpeechError.mediaFailed
            }
            let mixer = audio.mixer
            let lease = VendorAudioLease((mixer.outputVolume, mixer.micVolume, mixer.appVolume, mixer.soundPlayerVolume))
            reservation.held = true
            mixer.outputVolume = 0; mixer.micVolume = 0; mixer.appVolume = 0; mixer.soundPlayerVolume = 0
            return lease
        }
    }

    func release() throws {
        try Self.reservation.lock.withLock {
            let audio = AudioManager.shared; let mixer = audio.mixer
            guard !audio.isEngineRunning, !audio.isRecordingAlwaysPreparedMode,
                  mixer.outputVolume == 0, mixer.micVolume == 0,
                  mixer.appVolume == 0, mixer.soundPlayerVolume == 0 else { throw SpeechError.cleanupFailed }
            mixer.outputVolume = original.0; mixer.micVolume = original.1
            mixer.appVolume = original.2; mixer.soundPlayerVolume = original.3
            Self.reservation.held = false
        }
    }
}
