import Foundation

public enum SpeechRetention: String, Codable, Sendable {
    case originalAudioAndText = "original_audio_and_text", textOnly = "text_only", liveOnly = "live_only"
}
public enum SpeechListeningMode: String, Codable, Sendable {
    case translated, original, captionsOnly = "captions_only"
}

public struct SpeechContext: Codable, Sendable, Equatable {
    public let projectId: String
    public let sessionId: String
    public let participantId: String
    public let memberGeneration: UInt32
    public let retention: SpeechRetention
    public let canPublish: Bool
    public let canSubscribe: Bool
    public init(projectId: String, sessionId: String, participantId: String, memberGeneration: UInt32,
                retention: SpeechRetention, canPublish: Bool, canSubscribe: Bool) {
        self.projectId = projectId; self.sessionId = sessionId; self.participantId = participantId
        self.memberGeneration = memberGeneration; self.retention = retention
        self.canPublish = canPublish; self.canSubscribe = canSubscribe
    }
}
public struct SpeechSelection: Codable, Sendable, Equatable {
    public let targetLanguage: String
    public let mode: SpeechListeningMode
    public let sourceParticipantIds: [String]
    public init(targetLanguage: String, mode: SpeechListeningMode, sourceParticipantIds: [String]) {
        self.targetLanguage = targetLanguage; self.mode = mode; self.sourceParticipantIds = sourceParticipantIds
    }
}
public struct SpeechSubscription: Codable, Sendable, Equatable {
    public let revision: UInt32
    public let selection: SpeechSelection
    public init(revision: UInt32, selection: SpeechSelection) { self.revision = revision; self.selection = selection }
    private enum CodingKeys: String, CodingKey { case revision }
    public init(from decoder: any Decoder) throws {
        revision = try decoder.container(keyedBy: CodingKeys.self).decode(UInt32.self, forKey: .revision)
        selection = try SpeechSelection(from: decoder)
    }
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(revision, forKey: .revision)
        try selection.encode(to: encoder)
    }
}
public struct SpeechConfiguration: Codable, Sendable, Equatable {
    public let context: SpeechContext
    public let subscription: SpeechSubscription
    public init(context: SpeechContext, subscription: SpeechSubscription) { self.context = context; self.subscription = subscription }
}

/// Ephemeral participant authority from the host backend. Never log or persist the token.
public struct SpeechGrant: Codable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let protocolVersion: UInt8
    public let provider: String
    public let url: String
    public let room: String
    public let identity: String
    public let token: String
    public let expiresAt: String
    public let sessionId: String
    public let participantId: String
    public let memberGeneration: UInt32
    public let workerGeneration: UInt32
    public let processorIdentity: String
    public init(protocolVersion: UInt8, provider: String, url: String, room: String, identity: String,
                token: String, expiresAt: String, sessionId: String, participantId: String,
                memberGeneration: UInt32, workerGeneration: UInt32, processorIdentity: String) {
        self.protocolVersion = protocolVersion; self.provider = provider; self.url = url; self.room = room
        self.identity = identity; self.token = token; self.expiresAt = expiresAt; self.sessionId = sessionId
        self.participantId = participantId; self.memberGeneration = memberGeneration
        self.workerGeneration = workerGeneration; self.processorIdentity = processorIdentity
    }
    private enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol_version", provider, url, room, identity, token
        case expiresAt = "expires_at", sessionId = "session_id", participantId = "participant_id"
        case memberGeneration = "member_generation", workerGeneration = "worker_generation", processorIdentity = "processor_identity"
    }
    public var description: String { "SpeechGrant(redacted)" }
    public var debugDescription: String { description }
}

public struct SpeechTrack: Decodable, Sendable, Equatable {
    public let mediaTrackSid: String
    public let sourceId: String
    public let sourceEpoch: UInt64
    public let sourceParticipantId: String
    public let origin: String
    public let outputId: String?
}
public struct SpeechCaptionRequest: Decodable, Sendable, Equatable {
    public let requestId: UInt32
    public let projectId: String
    public let sessionId: String
    public let participantId: String
    public let memberGeneration: UInt32
    public let subscriptionRevision: UInt32
    public let limit: Int
    public let cursor: String?
}
public struct SpeechFinishRequest: Decodable, Sendable, Equatable {
    public let requestId: UInt32
    public let projectId: String
    public let sessionId: String
    public let participantId: String
    public let memberGeneration: UInt32
    public let workerGeneration: UInt32
    public let trackSid: String
    public let sourceId: String?
    public let sourceEpoch: UInt64?
}
public struct SpeechFinishBoundary: Decodable, Sendable, Equatable {
    public let state: String
    public let workerGeneration: UInt32
    public let sequence: String?
    public let samples: String?
    private enum CodingKeys: String, CodingKey { case state, workerGeneration = "worker_generation", sequence, samples }
}
public struct SpeechFinishedSource: Decodable, Sendable, Equatable {
    public let id: String
    public let epoch: UInt64
    public let participantId: String
    public let memberGeneration: UInt32
    public let trackSid: String
    public let state: String
    public let finish: SpeechFinishBoundary
    private enum CodingKeys: String, CodingKey {
        case id, epoch, participantId = "participant_id", memberGeneration = "member_generation", trackSid = "track_sid", state, finish
    }
}
public struct SpeechSourceFinish: Decodable, Sendable, Equatable {
    public let status: String
    public let holdPublication: Bool
    public let trackSid: String?
    public let source: SpeechFinishedSource?
    public let request: SpeechFinishRequest?
}
public struct SpeechCaptionRecovery: Decodable, Sendable, Equatable {
    public let status: String
    public let cursor: String?
    public let hasMore: Bool
    public let request: SpeechCaptionRequest?
}
/// Content-free state. Private caption content is delivered separately.
public struct SpeechState: Decodable, Sendable, Equatable {
    public let connected: Bool
    public let disconnect: Bool
    public let canCapture: Bool
    public let canPlay: Bool
    public let subscriptionRevision: UInt32
    public let changeId: UInt32
    public let clearGeneration: UInt32
    public let clearPlayback: Bool
    public let expiresAtMs: UInt64
    public let gap: Bool
    public let tracks: [SpeechTrack]
    public let recovery: SpeechCaptionRecovery
    public let sourceFinish: SpeechSourceFinish
    func closed() -> Self {
        Self(connected: false, disconnect: true, canCapture: false, canPlay: false,
             subscriptionRevision: subscriptionRevision, changeId: changeId, clearGeneration: clearGeneration,
             clearPlayback: true, expiresAtMs: expiresAtMs, gap: gap, tracks: [],
             recovery: .init(status: "closed", cursor: recovery.cursor, hasMore: false, request: nil),
             sourceFinish: .init(status: "closed", holdPublication: false, trackSid: sourceFinish.trackSid,
                                 source: sourceFinish.source, request: nil))
    }
}
public struct SpeechCaptionRecord: Decodable, Sendable {
    public let sourceId: String
    public let sourceEpoch: UInt64
    public let sourceParticipantId: String
    public let sourceMemberGeneration: UInt32
    public let unitId: String
    public let sourceFirstSeq: UInt64
    public let sourceLastSeq: UInt64
    public let startMs: Double
    public let endMs: Double
    public let sourceLanguage: String
    public let targetLanguage: String?
    public let text: String
}
/// Upsert by key. Never overwrite a final caption with a late draft.
public struct SpeechCaption: Decodable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let key: String
    public let origin: String
    public let isFinal: Bool
    public let subscriptionRevision: UInt32
    public let sequence: String?
    public let record: SpeechCaptionRecord
    private enum CodingKeys: String, CodingKey { case key, origin, isFinal = "final", subscriptionRevision, sequence, record }
    public var description: String { "SpeechCaption(content redacted)" }
    public var debugDescription: String { description }
}

public enum SpeechError: String, Error, Sendable {
    case invalidInput, closed, superseded, mediaFailed, mediaTimeout
    case subscriptionUnavailable, authorizationUnavailable, playbackBlocked, cleanupFailed
    case captionRecoveryUnavailable, captionRecoveryStale
    case sourceFinishUnavailable, sourceFinishStale, sourceFinishPending
}
public enum SpeechHostFailure: String, Error, Sendable {
    case unauthorized, staleSubscription = "stale_subscription", staleSource = "stale_source", unavailable
}
