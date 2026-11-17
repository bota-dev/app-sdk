import BotaAppSDK
import Foundation

struct LabJoin: Decodable, Sendable {
    struct Peer: Decodable, Sendable { let role: String; let participantId: String }
    let role: String
    let peer: Peer
    let allowedLanguages: [String]
    let configuration: SpeechConfiguration
    let grant: SpeechGrant
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
    private let originalCapable: Bool
    private var renewal: (@Sendable (SpeechGrant) -> Void)?
    nonisolated var supportsCaptionRecovery: Bool { true }
    nonisolated var supportsSourceFinish: Bool { true }

    init(origin: URL, role: String, code: String, transport: any LabTransport = NativeLabTransport(), originalCapable: Bool = false) throws {
        guard origin.scheme == "http", origin.host == "127.0.0.1", origin.user == nil, origin.password == nil,
              origin.query == nil, origin.fragment == nil, ["", "/"].contains(origin.path),
              (1...65535).contains(origin.port ?? 80), ["a", "b"].contains(role),
              code.range(of: "^[A-Za-z0-9_-]{32,128}$", options: .regularExpression) != nil else {
            transport.close(); throw LabFailure.invalidConfiguration
        }
        self.origin = origin; self.role = role; self.code = code; self.transport = transport; self.originalCapable = originalCapable
    }
    func join() async throws -> LabJoin {
        try active()
        guard joined == nil, !joining else { throw LabFailure.conflict }
        joining = true
        defer { joining = false }
        let payload = try await request("join", body: Data((originalCapable ? "{\"captureProfile\":\"speech_capture_pcm_v1\"}" : "{}").utf8))
        let value = try JSONDecoder().decode(LabJoin.self, from: payload)
        let context = value.configuration.context
        guard value.role == role, value.peer.role != role, ["a", "b"].contains(value.peer.role),
              value.peer.participantId != context.participantId,
              value.configuration.subscription.selection.sourceParticipantIds == [value.peer.participantId],
              (originalCapable || context.retention != .originalAudioAndText), context.canPublish, context.canSubscribe,
              value.allowedLanguages.contains(value.configuration.subscription.selection.targetLanguage),
              Set(value.allowedLanguages).count == value.allowedLanguages.count, value.allowedLanguages.count <= 7 else {
            throw LabFailure.unsupportedSession
        }
        try active(); joined = value; joinPayload = payload; revision = value.configuration.subscription.revision
        return value
    }
    func renewGrant() async throws -> SpeechGrant {
        try JSONDecoder().decode(SpeechGrant.self, from: await renewResponse())
    }
    private var joinPayload: Data?
    func takeJoinPayload() throws -> Data {
        try active(); guard let value = joinPayload else { throw LabFailure.closed }; joinPayload = nil; return value
    }
    func renewResponse() async throws -> Data {
        guard joined != nil else { throw LabFailure.closed }
        let payload = try await request("grant", body: Data("{}".utf8))
        let value = try JSONDecoder().decode(SpeechGrant.self, from: payload)
        renewal?(value); return payload
    }
    func observeRenewal(_ observer: @escaping @Sendable (SpeechGrant) -> Void) { renewal = observer }
    func prepareCapture(_ id: String) async throws -> Data {
        try await request("capture_prepare", body: JSONSerialization.data(withJSONObject: ["captureId": id]))
    }
    struct Capture: SpeechCaptureHost {
        let host: LabHost, id: String
        func status(captureId: String) async throws -> Data { try await host.captureRequest("status", expected: id, id: captureId) }
        func upload(captureId: String, packet: Data) async throws -> Data { try await host.captureRequest("chunk", expected: id, id: captureId, packet: packet) }
        func complete(captureId: String, manifest: Data) async throws -> Data { try await host.captureRequest("complete", expected: id, id: captureId, packet: manifest) }
    }
    nonisolated func capture(_ id: String) -> Capture { Capture(host: self, id: id) }
    private func captureRequest(_ action: String, expected: String, id: String, packet: Data? = nil) async throws -> Data {
        guard id == expected else { throw SpeechHostFailure.unauthorized }
        var body: [String: Any] = ["captureId": id]
        if let packet { body["packet"] = try JSONSerialization.jsonObject(with: packet) }
        return try await request("capture_" + action, body: JSONSerialization.data(withJSONObject: body))
    }
    func bindCapture(_ id: String, worker: UInt32, track: String) async throws {
        _ = try await request("capture_bind", body: JSONSerialization.data(withJSONObject: ["captureId": id, "workerGeneration": worker, "trackSid": track]))
    }
    func captureTranscript(_ id: String, after: Int, digest: String?) async throws -> Data {
        var body: [String: Any] = ["captureId": id, "afterSegment": after]
        if let digest { body["resultSha256"] = digest }
        return try await request("capture_transcript", body: JSONSerialization.data(withJSONObject: body))
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
    func close() { closed = true; code = ""; joined = nil; renewal = nil; joinPayload = nil; transport.close() }
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
        guard response.status == 200 || (action == "finish" && response.status == 202) ||
              (action.hasPrefix("capture_") && [201, 202].contains(response.status)) else { throw SpeechHostFailure.unavailable }
        return response.body
    }
}
