import BotaWatchControl
import Foundation

actor StubTransport: WatchHTTPTransport {
  var requests: [URLRequest] = []
  var replies: [WatchHTTPResponse]
  init(_ json: [String], status: Int = 200) {
    replies = json.map { WatchHTTPResponse(statusCode: status, data: Data($0.utf8)) }
  }
  func send(_ request: URLRequest) async throws -> WatchHTTPResponse {
    requests.append(request)
    guard !replies.isEmpty else { throw URLError(.timedOut) }
    return replies.removeFirst()
  }
  func enqueue(_ json: String) { replies.append(.init(statusCode: 200, data: Data(json.utf8))) }
}

let commandJSON =
  #"{"id":"cmd_1","device_id":"dev_1","type":"start_recording","status":"pending","grant_token":"must-not-be-retained"}"#

func makeClient(_ transport: any WatchHTTPTransport) throws -> WatchCloudClient {
  try WatchCloudClient(
    configuration: .init(baseURL: URL(string: "https://api.example.test")!),
    requestHeaders: { ["Authorization": "Bearer user-session"] },
    transport: transport
  )
}

func usesExistingCommandRouteAndExplicitAction() async throws {
  let transport = StubTransport([commandJSON])
  let client = try makeClient(transport)
  let intent = try client.makeIntent(deviceID: "dev_1", action: .startRecording)
  let command = try await client.submit(intent)
  check(command.status == .pending)
  let requests = await transport.requests
  check(requests.count == 1)
  check(requests[0].url?.path == "/devices/dev_1/commands")
  check(requests[0].value(forHTTPHeaderField: "Authorization") == "Bearer user-session")
  let body = try require(
    JSONSerialization.jsonObject(with: requests[0].httpBody!) as? [String: Any])
  check(body["type"] as? String == "start_recording")
  check(body["idempotency_key"] as? String == intent.id)
  check(!String(decoding: try JSONEncoder().encode(command), as: UTF8.self).contains("grant_token"))
}

func retriesReuseOriginalIntentAndDeadline() async throws {
  let transport = StubTransport([commandJSON, commandJSON])
  let client = try makeClient(transport)
  let intent = try client.makeIntent(deviceID: "dev_1", action: .startRecording)
  _ = try await client.submit(intent)
  _ = try await client.submit(intent)
  let requests = await transport.requests
  let bodies = try requests.map {
    try JSONSerialization.jsonObject(with: $0.httpBody!) as! [String: Any]
  }
  check(bodies[0]["idempotency_key"] as? String == bodies[1]["idempotency_key"] as? String)
  check((bodies[1]["ttl_seconds"] as! Int) <= (bodies[0]["ttl_seconds"] as! Int))
}

func lookupUsesReadOnlyListNotPendingClaim() async throws {
  let transport = StubTransport(["{\"data\":[\(commandJSON)]}"])
  let client = try makeClient(transport)
  let command = try await client.command(deviceID: "dev_1", commandID: "cmd_1")
  check(command?.id == "cmd_1")
  let requests = await transport.requests
  check(requests[0].url?.path == "/devices/dev_1/commands")
  check(requests[0].httpMethod == "GET")
}

func rejectsWrongDeviceResponse() async throws {
  let transport = StubTransport([commandJSON.replacingOccurrences(of: "dev_1", with: "dev_foreign")]
  )
  let client = try makeClient(transport)
  let intent = try client.makeIntent(deviceID: "dev_1", action: .startRecording)
  await checkThrows(WatchControlError.invalidResponse) { try await client.submit(intent) }
}

func refusesInsecureOriginAndPathTraversal() throws {
  checkThrows(WatchControlError.invalidConfiguration) {
    try WatchConfiguration(
      baseURL: URL(string: "http://api.example.test")!)
  }
  let client = try makeClient(StubTransport([]))
  checkThrows(WatchControlError.invalidIdentifier) {
    try client.makeIntent(deviceID: "../other", action: .startRecording)
  }
}

func expiredIntentNeverReachesNetwork() async throws {
  let transport = StubTransport([])
  let client = try makeClient(transport)
  let intent = try client.makeIntent(
    deviceID: "dev_1", action: .startRecording, now: Date().addingTimeInterval(-90))
  await checkThrows(WatchControlError.requestExpired) { try await client.submit(intent) }
  check(await transport.requests.isEmpty)
}

func customerHeaderFailureDoesNotSend() async throws {
  let transport = StubTransport([])
  let client = WatchCloudClient(
    configuration: try makeClient(transport).configuration,
    requestHeaders: { throw CheckFailure.missingValue }, transport: transport)
  await checkThrows(WatchControlError.requestPreparationFailed) { try await client.devices() }
  check(await transport.requests.isEmpty)
}

func malformedOrReservedHeadersDoNotSend() async throws {
  for headers in [
    ["Authorization": "token\r\nInjected: true"], ["Host": "other.test"],
    ["Content-Length": "999"], ["X-Invalid": "a\nb"],
    ["Authorization": "first", "authorization": "second"],
  ] {
    let transport = StubTransport([])
    let client = WatchCloudClient(
      configuration: try makeClient(transport).configuration,
      requestHeaders: { headers }, transport: transport)
    await checkThrows(WatchControlError.invalidHeaders) { try await client.devices() }
    check(await transport.requests.isEmpty)
  }
}

func httpErrorsAreSanitizedAndNeverRetried() async throws {
  let transport = StubTransport([#"{"error":"private backend details with secret"}"#], status: 403)
  let client = try makeClient(transport)
  let intent = try client.makeIntent(deviceID: "dev_1", action: .stopRecording)
  await checkThrows(WatchControlError.http(403)) { try await client.submit(intent) }
  check(await transport.requests.count == 1)
  check(!WatchControlError.http(403).localizedDescription.contains("secret"))
}

func stateIsReturnedWithoutBusinessActionSelection() async throws {
  let transport = StubTransport([
    #"{"device_id":"dev_1","recording_state":{"device_state":"syncing"}}"#
  ])
  let state = try await makeClient(transport).state(deviceID: "dev_1")
  check(state.recordingState?.deviceState == "syncing")
  check(state.observedAt == nil)
}

func lostPostIsRecoveredByRequestMetadataUsingOnlyGET() async throws {
  let transport = StubTransport([])
  let client = try makeClient(transport)
  let intent = try client.makeIntent(
    deviceID: "dev_1", action: .startRecording, now: Date().addingTimeInterval(-90))
  let response =
    commandJSON.dropLast() + ",\"params\":{\"metadata\":{\"watch_request_id\":\"\(intent.id)\"}}}"
  await transport.enqueue("{\"data\":[\(response)]}")
  let recovered = try await client.recover(intent)
  check(recovered?.id == "cmd_1")
  check(await transport.requests.allSatisfy { $0.httpMethod == "GET" })
}

func stopUsesExplicitStopAndDoesNotAcknowledge() async throws {
  let transport = StubTransport([
    commandJSON.replacingOccurrences(of: "start_recording", with: "stop_recording")
  ])
  let client = try makeClient(transport)
  let intent = try client.makeIntent(deviceID: "dev_1", action: .stopRecording)
  _ = try await client.submit(intent)
  let requests = await transport.requests
  check(requests.count == 1 && requests[0].url?.path == "/devices/dev_1/commands")
  let body = try JSONSerialization.jsonObject(with: requests[0].httpBody!) as! [String: Any]
  check(body["type"] as? String == "stop_recording")
}

func absentCommandRemainsUnknown() async throws {
  let transport = StubTransport([#"{"data":[]}"#])
  let command = try await makeClient(transport).command(deviceID: "dev_1", commandID: "cmd_old")
  check(command == nil)
  check(await transport.requests.count == 1)
}

func detailLookupUsesConfiguredExistingRouteAndValidatesIdentity() async throws {
  let transport = StubTransport([commandJSON, commandJSON])
  let client = WatchCloudClient(
    configuration: try .init(
      baseURL: URL(string: "https://api.example.test/v1")!, commandLookup: .detail),
    transport: transport)
  let command = try await client.command(deviceID: "dev_1", commandID: "cmd_1")
  check(command?.id == "cmd_1")
  await checkThrows(WatchControlError.invalidResponse) {
    try await client.command(deviceID: "dev_1", commandID: "cmd_wrong")
  }
  let requests = await transport.requests
  check(requests[0].url?.path == "/v1/devices/dev_1/commands/cmd_1")
  check(requests.allSatisfy { $0.httpMethod == "GET" })
}

func listLookupUsesExistingBoundedLimit() async throws {
  let transport = StubTransport([#"{"data":[]}"#])
  _ = try await makeClient(transport).command(deviceID: "dev_1", commandID: "cmd_1")
  let requests = await transport.requests
  let query = URLComponents(url: requests[0].url!, resolvingAgainstBaseURL: false)?.queryItems
  check(query == [URLQueryItem(name: "limit", value: "100")])
}

struct InvalidResponseTransport: WatchHTTPTransport {
  func send(_ request: URLRequest) async throws -> WatchHTTPResponse {
    throw WatchControlError.invalidResponse
  }
}

func transportContractErrorIsNotReportedAsNetworkFailure() async throws {
  let client = try makeClient(InvalidResponseTransport())
  await checkThrows(WatchControlError.invalidResponse) { try await client.devices() }
}

func cancellationDuringHeaderPreparationNeverSends() async throws {
  let transport = StubTransport([])
  let client = WatchCloudClient(
    configuration: try makeClient(transport).configuration,
    requestHeaders: { throw CancellationError() }, transport: transport)
  do {
    _ = try await client.devices()
    throw CheckFailure.expectedError
  } catch is CancellationError {}
  check(await transport.requests.isEmpty)
}

func minimumTTLCanBeSubmittedImmediately() async throws {
  let transport = StubTransport([commandJSON])
  let client = try makeClient(transport)
  let intent = try client.makeIntent(deviceID: "dev_1", action: .startRecording, ttlSeconds: 10)
  _ = try await client.submit(intent)
  let request = try require(await transport.requests.first)
  let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
  check(body["ttl_seconds"] as? Int == 10)
}

struct CancellingTransport: WatchHTTPTransport {
  func send(_ request: URLRequest) async throws -> WatchHTTPResponse {
    withUnsafeCurrentTask { $0?.cancel() }
    throw URLError(.cancelled)
  }
}

func urlSessionStyleCancellationIsPreserved() async throws {
  let client = try makeClient(CancellingTransport())
  let task = Task { try await client.devices() }
  do {
    _ = try await task.value
    throw CheckFailure.expectedError
  } catch is CancellationError {}
}
