import Foundation

/// Native control boundary for one already-started direct activity. Implementations
/// own input, live transport, playback and independent optional original archival.
/// close joins owned media; credentials and PCM stay in the native host.
public protocol RecordingSpeechConnection: AnyObject, Sendable {
    func changeTarget(language: String, requestId: String) async throws
    func qualifyHeadphones() async throws -> Bool
    func finish() async throws
    func close() async throws
}
