import Foundation

/// Retire the caller's owner; another capture must not replace uncertain cleanup.
public struct RecordingSpeechCleanupFailure: Error, Sendable { public init() {} }

/// Foreground microphone flow with independent encrypted archival. The host first
/// creates a mixed/unknown activity source at sample zero using the same clockId.
/// Provider/transport failure does not close the original capture or its archive.
public final class RecordingSpeechMicrophoneSession: RecordingSpeechConnection {
    public let live: RecordingSpeechSession
    public let microphone: SpeechMicrophoneCapture
    private let playback: RecordingSpeechAudioPlayback
    private final class RouteRelay: @unchecked Sendable {
        let lock = NSLock()
        weak var live: RecordingSpeechSession?
        func lost() { let value = lock.withLock { live }; Task { try? await value?.setRoute(headphones: false) } }
    }
    private init(live: RecordingSpeechSession, microphone: SpeechMicrophoneCapture, playback: RecordingSpeechAudioPlayback) {
        self.live = live; self.microphone = microphone; self.playback = playback
    }
    public static func start(configurationJSON: Data, grantJSON: Data, clockId: String, expiresAt: Date,
                             archive: SpeechCaptureArchive? = nil, headphoneRoute: @escaping @Sendable () -> Bool,
                             onCaption: @escaping @Sendable (Data) -> Void = { _ in },
                             onStatus: @escaping @Sendable (String) -> Void = { _ in }) async throws -> RecordingSpeechMicrophoneSession {
        let relay = RouteRelay()
        let playback = try RecordingSpeechAudioPlayback(headphoneRoute: headphoneRoute, onRouteLost: { relay.lost() })
        var live: RecordingSpeechSession?
        do {
            let session = try RecordingSpeechSession(configurationJSON: configurationJSON, grantJSON: grantJSON,
                playback: playback, onCaption: onCaption, onStatus: onStatus)
            live = session; relay.lock.withLock { relay.live = session }
            try await session.ready(); try session.bindMicrophone(clockId: clockId); try await session.setRoute(headphones: playback.qualifyHeadphones())
            try Task.checkCancellation()
            let microphone = try await SpeechMicrophoneCapture.start(archive: archive, expiresAt: expiresAt, clockId: clockId,
                onAudio: { first, pcm in session.offer(sourceIndex: 0, firstSample: first, pcm: pcm) },
                onArchiveError: { onStatus("archive_unavailable") }, ended: { reason in
                    if reason != .stopped { onStatus("capture_interrupted") }
                })
            return RecordingSpeechMicrophoneSession(live: session, microphone: microphone, playback: playback)
        } catch {
            do { try await live?.close() } catch { playback.close(); throw RecordingSpeechCleanupFailure() }
            playback.close(); throw error
        }
    }
    public func changeTarget(language: String, requestId: String) async throws { try await live.changeTarget(language, requestId: requestId) }
    public func qualifyHeadphones() async throws -> Bool { let qualified = try playback.qualifyHeadphones(); try await live.setRoute(headphones: qualified); return qualified }
    public func finish() async throws { try await microphone.stop(); try await live.finish() }
    public func close() async throws {
        var failure: (any Error)?
        do { try await microphone.interruptAndStop() } catch { failure = error }
        do { try await live.close() } catch { if failure == nil { failure = error } }
        playback.close()
        if let failure { throw failure }
    }
}
