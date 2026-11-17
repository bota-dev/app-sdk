import Foundation

public struct SpeechMediaCallbacks: Sendable {
    public let text: @Sendable (_ sender: String, _ json: String) -> Void
    public let trackRemoved: @Sendable (_ mediaTrackSid: String) -> Void
    public let disconnected: @Sendable () -> Void
    public let failed: @Sendable () -> Void
    public let playbackBlocked: @Sendable () -> Void
    public init(text: @escaping @Sendable (String, String) -> Void, trackRemoved: @escaping @Sendable (String) -> Void,
                disconnected: @escaping @Sendable () -> Void, failed: @escaping @Sendable () -> Void,
                playbackBlocked: @escaping @Sendable () -> Void) {
        self.text = text; self.trackRemoved = trackRemoved; self.disconnected = disconnected
        self.failed = failed; self.playbackBlocked = playbackBlocked
    }
}

/// Native IO only. connect does not start capture; new receive tracks stay silent
/// until setPlayback admits their exact identity. Synchronous mute/silence/hold
/// fence current AND pending acquisitions. Cancelled operations may finish late:
/// setInput(true) must not clear a hold, including when its invocation starts late.
/// Clear the hold only after setInput(false) has fully stopped that publication.
/// the port must retire their callbacks and close must join actual cleanup,
/// preserving unrelated host audio. Throw if native ownership remains uncertain.
public protocol SpeechMediaPort: Sendable {
    func connect(grant: SpeechGrant) async throws
    func silencePlayback() throws
    func muteInput() throws
    func clearPlayback() async throws
    func setPlayback(tracks: [SpeechTrack]) async throws
    func setInput(enabled: Bool) async throws
    var supportsSourceFinish: Bool { get }
    func holdInput() throws
    func inputPublication() throws -> String?
    func resumeAudio() async throws
    func close() async throws
}
public extension SpeechMediaPort {
    var supportsSourceFinish: Bool { false }
    func holdInput() throws { throw SpeechError.sourceFinishUnavailable }
    func inputPublication() throws -> String? { throw SpeechError.sourceFinishUnavailable }
    func resumeAudio() async throws {}
}

/// Calls the application's authenticated backend; never embeds a Bota project/provider key.
public protocol SpeechHostCallbacks: Sendable {
    func changeSubscription(selection: SpeechSelection) async throws -> SpeechSubscription
    func renewGrant() async throws -> SpeechGrant
    var supportsCaptionRecovery: Bool { get }
    /// Return the unchanged HTTP response body for shared Rust validation.
    func readCaptions(request: SpeechCaptionRequest) async throws -> Data
    var supportsSourceFinish: Bool { get }
    /// Finish only the exact publisher/source from the request; return the unchanged body.
    func finishSource(request: SpeechFinishRequest) async throws -> Data
}
public extension SpeechHostCallbacks {
    var supportsCaptionRecovery: Bool { false }
    func readCaptions(request: SpeechCaptionRequest) async throws -> Data { throw SpeechHostFailure.unavailable }
    var supportsSourceFinish: Bool { false }
    func finishSource(request: SpeechFinishRequest) async throws -> Data { throw SpeechHostFailure.unavailable }
}

/// Callbacks run synchronously on the invoking SDK thread. Do not block; dispatch
/// UI and async session calls to the application's task/actor. Events may contain
/// private text and must not be logged. Caption UI should upsert caption.key.
public struct SpeechObserver: Sendable {
    public let stateChanged: @Sendable (SpeechState) -> Void
    public let caption: @Sendable (SpeechCaption) -> Void
    public let event: @Sendable (Data) -> Void
    public let error: @Sendable (SpeechError) -> Void
    public init(stateChanged: @escaping @Sendable (SpeechState) -> Void = { _ in },
                caption: @escaping @Sendable (SpeechCaption) -> Void = { _ in },
                event: @escaping @Sendable (Data) -> Void = { _ in },
                error: @escaping @Sendable (SpeechError) -> Void = { _ in }) {
        self.stateChanged = stateChanged; self.caption = caption; self.event = event; self.error = error
    }
}
