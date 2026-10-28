import Foundation

private final class ByoRedirectPolicy: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
protocol ByoStreamSocket: Sendable {
    func exchange(_ segment: Data, bytes: Data) async throws -> Data
    func close() async
}
protocol ByoControlClient: Sendable {
    func control(_ suffix: String, body: Data?, context: Bool) async throws -> Data
    func put(_ instructions: Data, file: URL) async throws
    func streamControl(_ suffix: String, body: Data?) async throws -> Data
    func streamSocket(_ session: String) async throws -> any ByoStreamSocket
}
extension ByoControlClient {
    func streamControl(_ suffix: String, body: Data? = nil) async throws -> Data { throw ByoFailure.protocolViolation }
    func streamSocket(_ session: String) async throws -> any ByoStreamSocket { throw ByoFailure.protocolViolation }
    func control(_ suffix: String, body: Data? = nil) async throws -> Data {
        try await control(suffix, body: body, context: false)
    }
}
actor ByoHTTP: ByoControlClient {
    private let options: ByoStorageOptions
    private let session: URLSession
    init(_ options: ByoStorageOptions) throws {
        guard let parts = URLComponents(url: options.baseURL, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.host != nil, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, !options.scopeKey.isEmpty,
              options.stateDirectory.isFileURL, options.bindingGeneration > 0,
              [options.deviceID, options.projectID, options.organizationID].allSatisfy({
                  !$0.isEmpty && $0.utf8.count <= 128 && $0.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
              }), ["development", "gamma", "production"].contains(options.environment) else { throw ByoFailure.invalidConfiguration }
        self.options = options
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCredentialStorage = nil; config.urlCache = nil
        config.timeoutIntervalForRequest = 30; config.timeoutIntervalForResource = 600
        session = URLSession(configuration: config, delegate: ByoRedirectPolicy(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    func control(_ suffix: String, body: Data? = nil, context: Bool = false) async throws -> Data {
        try await request(suffix, body: body, route: context ? "encrypted-upload-v2/contexts" : "byo-uploads")
    }
    func streamControl(_ suffix: String, body: Data? = nil) async throws -> Data {
        try await request(suffix, body: body, route: "byo-streams")
    }
    private func request(_ suffix: String, body: Data?, route: String) async throws -> Data {
        guard suffix.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45, 47, 95].contains($0) }) else { throw ByoFailure.protocolViolation }
        let path = "devices/\(options.deviceID)/" + route + suffix
        let url = options.baseURL.appendingPathComponent(path)
        for attempt in 0..<3 {
            try Task.checkCancellation(); try await options.validateScope()
            let token = try await options.accessToken()
            guard !token.isEmpty, token.utf8.count <= 16384, token.utf8.allSatisfy({ (33...126).contains($0) }) else { throw ByoFailure.invalidConfiguration }
            var request = URLRequest(url: url); request.httpMethod = body == nil ? "GET" : "POST"; request.httpBody = body
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            request.setValue(String(options.bindingGeneration), forHTTPHeaderField: "x-bota-device-binding")
            request.setValue(options.organizationID, forHTTPHeaderField: "x-organization-id")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let (data, response) = try await session.data(for: request)
            try Task.checkCancellation(); try await options.validateScope()
            guard let response = response as? HTTPURLResponse, data.count <= 32768 else { throw ByoFailure.protocolViolation }
            if (200..<300).contains(response.statusCode) { return data }
            if attempt < 2 && ([425, 429].contains(response.statusCode) || response.statusCode >= 500),
               let delay = byoRetryDelay(response.value(forHTTPHeaderField: "Retry-After"), fallback: Double(attempt + 1) * 2) {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)); continue
            }
            if response.statusCode == 409,
               let error = (try? byoObject(data))?["error"] as? [String: Any], error["code"] as? String == "expired" {
                throw ByoFailure.expiredAuthorization
            }
            throw ByoFailure.http(response.statusCode)
        }
        throw ByoFailure.pending
    }
    static func uploadRequest(_ instructions: Data) throws -> URLRequest {
        let object = try byoObject(instructions)
        guard object["method"] as? String == "PUT", let text = object["url"] as? String, text.utf8.count <= 8192,
              let url = URL(string: text), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.host != nil, parts.user == nil, parts.password == nil, parts.fragment == nil,
              let headers = object["headers"] as? [String: String] else { throw ByoFailure.protocolViolation }
        var request = URLRequest(url: url); request.httpMethod = "PUT"
        _ = try byoCustomer(3, headers)
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        return request
    }
    func put(_ instructions: Data, file: URL) async throws {
        let request = try Self.uploadRequest(instructions)
        try Task.checkCancellation(); try await options.validateScope()
        let (_, response) = try await session.upload(for: request, fromFile: file)
        try Task.checkCancellation(); try await options.validateScope()
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw ByoFailure.http((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
    }
    func streamSocket(_ id: String) async throws -> any ByoStreamSocket {
        guard UUID(uuidString: id)?.uuidString.lowercased() == id else { throw ByoFailure.protocolViolation }
        try Task.checkCancellation(); try await options.validateScope()
        let token = try await options.accessToken()
        guard !token.isEmpty, token.utf8.count <= 16384, token.utf8.allSatisfy({ (33...126).contains($0) }) else { throw ByoFailure.invalidConfiguration }
        var url = URLComponents(url: options.baseURL.appendingPathComponent("devices/\(options.deviceID)/byo-streams/ws"), resolvingAgainstBaseURL: false)!
        url.scheme = "wss"
        var request = URLRequest(url: url.url!, timeoutInterval: 30)
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue(String(options.bindingGeneration), forHTTPHeaderField: "x-bota-device-binding")
        request.setValue(options.organizationID, forHTTPHeaderField: "x-organization-id")
        request.setValue("bota-byo-stream-v1", forHTTPHeaderField: "Sec-WebSocket-Protocol")
        let socket = ByoWebSocket(task: session.webSocketTask(with: request), id: id, validate: options.validateScope)
        try await socket.open(); return socket
    }
    func contextExchange(_ nonce: Data) async throws -> EncryptedUploadV2ContextExchange {
        guard nonce.count == 16 else { throw ByoFailure.protocolViolation }
        let initial = try byoDataObject(await control("", body: byoJSON(["nonce_base64": nonce.base64EncodedString()]), context: true))
        guard let id = initial["context_id"] as? String, UUID(uuidString: id) != nil,
              let encoded = initial["challenge_base64"] as? String, let challenge = Data(base64Encoded: encoded), challenge.count == 196 else { throw ByoFailure.protocolViolation }
        return EncryptedUploadV2ContextExchange(challenge: challenge, exchangeProof: { proof in
            try await self.contextProof(id: id, challenge: encoded, proof: proof)
        })
    }
    private func contextProof(id: String, challenge: String, proof: Data) async throws -> Data {
        guard (116...366).contains(proof.count) else { throw ByoFailure.protocolViolation }
        var data = try await control("/" + id + "/proof", body: byoJSON(["proof_base64": proof.base64EncodedString()]), context: true)
        for _ in 0..<100 {
            let reply = try byoDataObject(data)
            guard reply["context_id"] as? String == id, reply["challenge_base64"] as? String == challenge else { throw ByoFailure.identityConflict }
            if reply["state"] as? String == "complete", let value = reply["result_base64"] as? String,
               let result = Data(base64Encoded: value), result.count == 264 { return result }
            guard reply["state"] as? String == "pending" else { throw ByoFailure.protocolViolation }
            try await Task.sleep(nanoseconds: 250_000_000)
            data = try await control("/" + id, context: true)
        }
        throw ByoFailure.pending
    }
}
func byoObject(_ data: Data) throws -> [String: Any] {
    guard data.count <= 32768, let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ByoFailure.protocolViolation }
    return object
}
func byoDataObject(_ data: Data) throws -> [String: Any] {
    guard let object = try byoObject(data)["data"] as? [String: Any] else { throw ByoFailure.protocolViolation }; return object
}
func byoJSON(_ object: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]) }

/// A longer backoff returns to the host rather than retrying before its deadline.
func byoRetryDelay(_ header: String?, fallback: TimeInterval, now: Date = Date()) -> TimeInterval? {
    var delay = fallback
    if let value = header?.trimmingCharacters(in: .whitespacesAndNewlines) {
        if let seconds = Double(value), seconds.isFinite, seconds >= 0 { delay = max(delay, seconds) }
        else {
            let format = DateFormatter(); format.locale = Locale(identifier: "en_US_POSIX")
            format.timeZone = TimeZone(secondsFromGMT: 0); format.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
            if let date = format.date(from: value) { delay = max(delay, date.timeIntervalSince(now)) }
        }
    }
    return delay <= 30 ? delay : nil
}

private actor ByoWebSocket: ByoStreamSocket {
    let task: URLSessionWebSocketTask
    let id: String
    let validate: @Sendable () async throws -> Void
    init(task: URLSessionWebSocketTask, id: String, validate: @escaping @Sendable () async throws -> Void) {
        self.task = task; self.id = id; self.validate = validate; task.maximumMessageSize = 32768
    }
    func open() async throws {
        task.resume()
        do {
            try await send(.string(String(decoding: byoJSON(["type": "resume", "session_id": id]), as: UTF8.self)))
            let ready = try byoObject(await receive())
            guard (task.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Sec-WebSocket-Protocol") == "bota-byo-stream-v1" else { throw ByoFailure.protocolViolation }
            guard ready["type"] as? String == "ready", ready["session_id"] as? String == id else { throw ByoFailure.protocolViolation }
            try await validate()
        } catch { close(); throw error }
    }
    func exchange(_ segment: Data, bytes: Data) async throws -> Data {
        try Task.checkCancellation(); try await validate()
        guard segment.count <= 1024, bytes.count <= 16384 else { throw ByoFailure.protocolViolation }
        var size = UInt32(segment.count).bigEndian
        var frame = withUnsafeBytes(of: &size) { Data($0) }; frame.append(segment); frame.append(bytes)
        try await send(.data(frame)); let data = try await receive(); let ack = try byoObject(data)
        guard ack["type"] as? String == "ack", ack["session_id"] as? String == id,
              let value = ack["segment"] as? [String: Any], try byoJSON(value) == segment else { throw ByoFailure.protocolViolation }
        try await validate(); return data
    }
    private func send(_ message: URLSessionWebSocketTask.Message) async throws {
        let task = task
        try await withTaskCancellationHandler { try await task.send(message) }
            onCancel: { task.cancel(with: .goingAway, reason: nil) }
    }
    private func receive() async throws -> Data {
        let task = task
        return try await withTaskCancellationHandler {
            try await withThrowingTaskGroup(of: Data.self) { group in
                group.addTask {
                    switch try await task.receive() {
                    case .string(let text): return Data(text.utf8)
                    default: throw ByoFailure.protocolViolation
                    }
                }
                group.addTask {
                    try await Task.sleep(nanoseconds: 30_000_000_000)
                    task.cancel(with: .goingAway, reason: nil); throw ByoFailure.pending
                }
                defer { group.cancelAll() }
                return try await group.next()!
            }
        } onCancel: { task.cancel(with: .goingAway, reason: nil) }
    }
    func close() { task.cancel(with: .goingAway, reason: nil) }
}
