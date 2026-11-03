import BotaAppSDK
import Foundation

enum LabFailure: String, Error, Sendable {
    case invalidConfiguration, unavailable, unsupportedSession, conflict, closed
}

struct LabJoin: Decodable, Sendable {
    struct Peer: Decodable, Sendable { let role: String; let participantId: String }
    let role: String
    let peer: Peer
    let allowedLanguages: [String]
    let configuration: SpeechConfiguration
    let grant: SpeechGrant
}

struct LabResponse: Sendable { let status: Int; let body: Data }
protocol LabTransport: Sendable {
    func send(_ request: URLRequest) async throws -> LabResponse
    func close()
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class NativeLabTransport: LabTransport, @unchecked Sendable {
    private let session: URLSession
    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 8
        session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }
    func send(_ request: URLRequest) async throws -> LabResponse {
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        guard let response = response as? HTTPURLResponse, response.expectedContentLength <= 524_288 else {
            throw LabFailure.unavailable
        }
        var body = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard body.count < 524_288 else { throw LabFailure.unavailable }
            body.append(byte)
        }
        return LabResponse(status: response.statusCode, body: body)
    }
    func close() { session.invalidateAndCancel() }
    deinit { session.invalidateAndCancel() }
}

/// Operator-only loopback host for the source companion. No project/provider
/// credential is accepted. Each owner gets a fresh grant and forgets its code on close.
actor LabHost: SpeechHostCallbacks {
    private let origin: URL
    private let role: String
    private var code: String
    private let transport: any LabTransport
    private var joined: LabJoin?
    private var joining = false
    private var revision: UInt32 = 0
    private var closed = false
    nonisolated var supportsCaptionRecovery: Bool { true }
    nonisolated var supportsSourceFinish: Bool { true }

    init(origin: URL, role: String, code: String, transport: any LabTransport = NativeLabTransport()) throws {
        guard origin.scheme == "http", origin.host == "127.0.0.1", origin.user == nil, origin.password == nil,
              origin.query == nil, origin.fragment == nil, ["", "/"].contains(origin.path),
              (1...65535).contains(origin.port ?? 80), ["a", "b"].contains(role),
              code.range(of: "^[A-Za-z0-9_-]{32,128}$", options: .regularExpression) != nil else {
            transport.close(); throw LabFailure.invalidConfiguration
        }
        self.origin = origin; self.role = role; self.code = code; self.transport = transport
    }
    func join() async throws -> LabJoin {
        try active()
        guard joined == nil, !joining else { throw LabFailure.conflict }
        joining = true
        defer { joining = false }
        let value = try JSONDecoder().decode(LabJoin.self, from: await request("join", body: Data("{}".utf8)))
        let context = value.configuration.context
        guard value.role == role, value.peer.role != role, ["a", "b"].contains(value.peer.role),
              value.peer.participantId != context.participantId,
              value.configuration.subscription.selection.sourceParticipantIds == [value.peer.participantId],
              context.retention != .originalAudioAndText, context.canPublish, context.canSubscribe,
              value.allowedLanguages.contains(value.configuration.subscription.selection.targetLanguage),
              Set(value.allowedLanguages).count == value.allowedLanguages.count, value.allowedLanguages.count <= 7 else {
            throw LabFailure.unsupportedSession
        }
        try active(); joined = value; revision = value.configuration.subscription.revision
        return value
    }
    func renewGrant() async throws -> SpeechGrant {
        guard joined != nil else { throw LabFailure.closed }
        return try JSONDecoder().decode(SpeechGrant.self, from: await request("grant", body: Data("{}".utf8)))
    }
    func changeSubscription(selection: SpeechSelection) async throws -> SpeechSubscription {
        guard let joined, selection.sourceParticipantIds == [joined.peer.participantId],
              joined.allowedLanguages.contains(selection.targetLanguage) else { throw SpeechError.invalidInput }
        struct Change: Encodable { let expectedRevision: UInt32; let targetLanguage: String; let mode: SpeechListeningMode }
        let body = try JSONEncoder().encode(Change(expectedRevision: revision, targetLanguage: selection.targetLanguage, mode: selection.mode))
        let value = try JSONDecoder().decode(SpeechSubscription.self, from: await request("subscription", body: body))
        try active(); revision = value.revision
        return value
    }
    func readCaptions(request input: SpeechCaptionRequest) async throws -> Data {
        try own(input.projectId, input.sessionId, input.participantId, input.memberGeneration)
        struct Read: Encodable { let subscriptionRevision: UInt32; let limit: Int; let cursor: String? }
        do {
            return try await request("captions", body: JSONEncoder().encode(Read(
                subscriptionRevision: input.subscriptionRevision, limit: input.limit, cursor: input.cursor)))
        } catch LabFailure.conflict { throw SpeechHostFailure.staleSubscription }
    }
    func finishSource(request input: SpeechFinishRequest) async throws -> Data {
        try own(input.projectId, input.sessionId, input.participantId, input.memberGeneration)
        struct Finish: Encodable {
            let workerGeneration: UInt32; let trackSid: String; let sourceId: String?; let sourceEpoch: UInt64?
            enum CodingKeys: String, CodingKey { case workerGeneration, trackSid, sourceId, sourceEpoch }
            func encode(to encoder: any Encoder) throws {
                var fields = encoder.container(keyedBy: CodingKeys.self)
                try fields.encode(workerGeneration, forKey: .workerGeneration)
                try fields.encode(trackSid, forKey: .trackSid)
                // The loopback contract distinguishes explicit unknown boundaries from missing fields.
                try fields.encode(sourceId, forKey: .sourceId)
                try fields.encode(sourceEpoch, forKey: .sourceEpoch)
            }
        }
        do {
            return try await request("finish", body: JSONEncoder().encode(Finish(workerGeneration: input.workerGeneration,
                trackSid: input.trackSid, sourceId: input.sourceId, sourceEpoch: input.sourceEpoch)))
        } catch LabFailure.conflict { throw SpeechHostFailure.staleSource }
    }
    func close() { closed = true; code = ""; joined = nil; transport.close() }
    private func active() throws { try Task.checkCancellation(); if closed { throw LabFailure.closed } }
    private func own(_ project: String, _ session: String, _ participant: String, _ generation: UInt32) throws {
        guard let context = joined?.configuration.context, context.projectId == project, context.sessionId == session,
              context.participantId == participant, context.memberGeneration == generation else { throw SpeechHostFailure.unauthorized }
    }
    private func request(_ action: String, body: Data) async throws -> Data {
        try active()
        var request = URLRequest(url: origin.appendingPathComponent("speech-host/" + action), cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = "POST"; request.httpBody = body; request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        request.setValue(role, forHTTPHeaderField: "X-Speech-Role")
        request.setValue(code, forHTTPHeaderField: "X-Speech-Code")
        let response: LabResponse
        do { response = try await transport.send(request) }
        catch { try active(); throw SpeechHostFailure.unavailable }
        try active()
        guard response.body.count <= 524_288 else { throw SpeechHostFailure.unavailable }
        if response.status == 403 { throw SpeechHostFailure.unauthorized }
        if response.status == 409 {
            struct Failure: Decodable { struct Detail: Decodable { let code: String }; let error: Detail }
            if (try? JSONDecoder().decode(Failure.self, from: response.body).error.code) == "not_ready" {
                throw SpeechHostFailure.unavailable
            }
            throw LabFailure.conflict
        }
        guard response.status == 200 || (action == "finish" && response.status == 202) else { throw SpeechHostFailure.unavailable }
        return response.body
    }
}
