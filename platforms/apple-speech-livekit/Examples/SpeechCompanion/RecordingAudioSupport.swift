import AVFAudio
import Foundation

struct OriginalView: Sendable {
    var enabled = false, capturing = false, finished = false
    var status = "", passages: [String] = []
}

/// Only the standalone companion owns global audio routing; reusable capture
/// requires the host to supply its own audio session and preserves its settings.
@MainActor final class OriginalAudioRoute {
    #if os(iOS)
    private static var held = false
    private let session = AVAudioSession.sharedInstance()
    private let prior: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)
    private let options: AVAudioSession.CategoryOptions
    init() throws {
        guard !Self.held else { throw LabFailure.conflict }
        prior = (session.category, session.mode, session.categoryOptions)
        #if compiler(>=6.2)
        options = [.allowBluetoothHFP]
        #else
        options = [.allowBluetooth]
        #endif
        Self.held = true
        do { try session.setCategory(.playAndRecord, mode: .voiceChat, options: options); try session.setActive(true) }
        catch { try? close(); throw error }
    }
    func close() throws {
        guard session.category == .playAndRecord, session.mode == .voiceChat, session.categoryOptions == options else { throw LabFailure.unavailable }
        try session.setActive(false, options: .notifyOthersOnDeactivation)
        try session.setCategory(prior.0, mode: prior.1, options: prior.2)
        Self.held = false
    }
    #else
    init() throws {}
    func close() throws {}
    #endif
}
