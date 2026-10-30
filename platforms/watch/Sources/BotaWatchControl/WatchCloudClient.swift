import Foundation

/// An opt-in adapter for existing user-authenticated HTTP routes, separate from the BLE SDK.
public struct WatchCloudClient: Sendable {
  public let configuration: WatchConfiguration
  private let requestHeaders: @Sendable () async throws -> [String: String]
  private let transport: any WatchHTTPTransport

  public init(
    configuration: WatchConfiguration,
    requestHeaders: @escaping @Sendable () async throws -> [String: String] = { [:] },
    transport: any WatchHTTPTransport = WatchURLSessionTransport()
  ) {
    self.configuration = configuration
    self.requestHeaders = requestHeaders
    self.transport = transport
  }

  public func makeIntent(
    deviceID: String, action: RecordingAction, now: Date = Date(), ttlSeconds: Int = 60
  ) throws -> RecordingIntent {
    guard validID(deviceID) else { throw WatchControlError.invalidIdentifier }
    guard (10...300).contains(ttlSeconds) else { throw WatchControlError.invalidConfiguration }
    return RecordingIntent(
      id: UUID().uuidString, endpoint: configuration.endpoint, deviceID: deviceID,
      action: action, createdAt: now, expiresAt: now.addingTimeInterval(Double(ttlSeconds)))
  }

  public func devices(cursor: String? = nil) async throws -> WatchPage<WatchDevice> {
    var query: [URLQueryItem] = []
    if let cursor { query.append(.init(name: "cursor", value: cursor)) }
    let page: WatchPage<WatchDevice> = try await request(suffix: "", query: query)
    guard page.data.allSatisfy({ validID($0.id) }) else { throw WatchControlError.invalidResponse }
    return page
  }

  public func state(deviceID: String) async throws -> WatchDeviceState {
    try checkID(deviceID)
    let state: WatchDeviceState = try await request(suffix: "/\(deviceID)/state")
    guard state.deviceID == deviceID else { throw WatchControlError.invalidResponse }
    return state
  }

  /// A read-only list lookup also works with existing App backends without a detail GET route.
  /// A missing command is unknown, never evidence of failure or permission to start again.
  public func command(deviceID: String, commandID: String) async throws -> WatchCommand? {
    try checkID(deviceID)
    try checkID(commandID)
    if configuration.commandLookup == .detail {
      let command: WatchCommand = try await request(suffix: "/\(deviceID)/commands/\(commandID)")
      guard command.id == commandID, command.deviceID == deviceID else {
        throw WatchControlError.invalidResponse
      }
      return command
    }
    let page = try await commandPage(deviceID: deviceID)
    let matches = page.data.filter { $0.id == commandID }
    guard matches.count <= 1, matches.first.map({ $0.deviceID == deviceID }) ?? true else {
      throw WatchControlError.invalidResponse
    }
    return matches.first
  }

  /// Finds an accepted command after its POST response was lost, without creating another command.
  public func recover(_ intent: RecordingIntent) async throws -> WatchCommand? {
    try validate(intent)
    let page = try await commandPage(deviceID: intent.deviceID)
    let matches = page.data.filter { $0.params?.metadata?.watchRequestID == intent.id }
    guard matches.count <= 1 else { throw WatchControlError.invalidResponse }
    guard let command = matches.first else { return nil }
    guard validID(command.id), command.deviceID == intent.deviceID,
      command.type == intent.action.rawValue
    else {
      throw WatchControlError.invalidResponse
    }
    return command
  }

  /// Reuse this exact intent when recovering a lost POST response. No automatic POST retries.
  public func submit(_ intent: RecordingIntent) async throws -> WatchCommand {
    try validate(intent)
    let command: WatchCommand = try await request(
      suffix: "/\(intent.deviceID)/commands", intent: intent)
    guard validID(command.id), command.deviceID == intent.deviceID,
      command.type == intent.action.rawValue
    else {
      throw WatchControlError.invalidResponse
    }
    return command
  }

  func validate(_ intent: RecordingIntent) throws {
    guard intent.endpoint == configuration.endpoint else {
      throw WatchControlError.endpointMismatch
    }
    try checkID(intent.deviceID)
    guard UUID(uuidString: intent.id) != nil,
      (10...300).contains(intent.expiresAt.timeIntervalSince(intent.createdAt)),
      intent.createdAt <= Date().addingTimeInterval(5)
    else { throw WatchControlError.invalidResponse }
  }

  private func checkID(_ id: String) throws {
    guard validID(id) else { throw WatchControlError.invalidIdentifier }
  }

  private func commandPage(deviceID: String) async throws -> WatchPage<WatchCommand> {
    // Existing commands lists accept a bounded limit, not cursor pagination.
    try await request(
      suffix: "/\(deviceID)/commands", query: [.init(name: "limit", value: "100")])
  }

  private func request<T: Decodable>(
    suffix: String, query: [URLQueryItem] = [], intent: RecordingIntent? = nil
  ) async throws -> T {
    try Task.checkCancellation()
    let headers: [String: String]
    do { headers = try await requestHeaders() } catch is CancellationError {
      throw CancellationError()
    } catch {
      try Task.checkCancellation()
      throw WatchControlError.requestPreparationFailed
    }
    let reserved = Set([
      "host", "content-length", "transfer-encoding", "connection", "content-type", "accept",
    ])
    var names: Set<String> = []
    guard headers.count <= 32,
      headers.allSatisfy({ key, value in
        let normalized = key.lowercased()
        return validID(key) && names.insert(normalized).inserted && !reserved.contains(normalized)
          && value.utf8.count <= 16384 && value.utf8.allSatisfy { $0 >= 32 && $0 != 127 }
      })
    else { throw WatchControlError.invalidHeaders }
    guard var url = URLComponents(url: configuration.baseURL, resolvingAgainstBaseURL: false) else {
      throw WatchControlError.invalidConfiguration
    }
    url.path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    url.path = (url.path.isEmpty ? "" : "/" + url.path) + configuration.devicesPath + suffix
    if !query.isEmpty { url.queryItems = query }
    guard let requestURL = url.url else { throw WatchControlError.invalidConfiguration }
    var request = URLRequest(
      url: requestURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
    request.httpMethod = "GET"
    for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let intent {
      // Check the deadline after the customer prepares request headers.
      // The server accepts whole seconds. Round up by less than one second so
      // an intent created with the minimum TTL is not immediately unsendable.
      let remaining = Int(ceil(intent.expiresAt.timeIntervalSinceNow))
      guard remaining >= 10 else { throw WatchControlError.requestExpired }
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONEncoder().encode(
        CommandBody(
          type: intent.action.rawValue, idempotencyKey: intent.id, ttlSeconds: remaining,
          params: .init(metadata: .init(watchRequestID: intent.id))
        ))
    }
    try Task.checkCancellation()
    let response: WatchHTTPResponse
    do { response = try await transport.send(request) } catch is CancellationError {
      throw CancellationError()
    } catch {
      // URLSession commonly reports a cancelled task as URLError.cancelled.
      try Task.checkCancellation()
      if let error = error as? WatchControlError { throw error }
      throw WatchControlError.networkUnavailable
    }
    try Task.checkCancellation()
    guard (200...299).contains(response.statusCode) else {
      throw WatchControlError.http(response.statusCode)
    }
    guard response.data.count <= 1_048_576 else { throw WatchControlError.invalidResponse }
    do { return try JSONDecoder().decode(T.self, from: response.data) } catch {
      throw WatchControlError.invalidResponse
    }
  }
}

private struct CommandBody: Encodable {
  let type: String
  let idempotencyKey: String
  let ttlSeconds: Int
  let params: Parameters
  enum CodingKeys: String, CodingKey {
    case type, params
    case idempotencyKey = "idempotency_key"
    case ttlSeconds = "ttl_seconds"
  }
  struct Parameters: Encodable {
    let metadata: Metadata
    struct Metadata: Encodable {
      let watchRequestID: String
      enum CodingKeys: String, CodingKey { case watchRequestID = "watch_request_id" }
    }
  }
}
