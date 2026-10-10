import Foundation
import CoreFoundation

/** Scalar-only read boundary; all HTTP runs through the no-redirect native client. */
@MainActor final class UploadStreamingStatus {
  private let http: any UploadHTTP
  init(http: any UploadHTTP = UploadURLSessionHTTP()) { self.http = http }
  func read(_ input: String) async throws -> String {
    guard let object = try JSONSerialization.jsonObject(with: Data(input.utf8)) as? [String: Any],
      let address = object["url"] as? String, let token = object["token"] as? String,
      let org = object["organizationId"] as? String,
      UploadValidation.matches(address, "https://[A-Za-z0-9.-]+(?::[0-9]+)?(?:/[A-Za-z0-9_-]+)+/recordings/rec_[A-Za-z0-9_-]+/streaming-status\\?session_id=[0-9a-f-]{36}"),
      let url = URL(string: address), (1...16384).contains(token.utf8.count),
      token.utf8.allSatisfy({ (33...126).contains($0) }),
      org.isEmpty || UploadValidation.matches(org, "[A-Za-z0-9_-]{1,128}") else { throw UploadFailure.invalidInput }
    try Task.checkCancellation()
    var request = URLRequest(url: url); request.httpMethod = "GET"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if !org.isEmpty { request.setValue(org, forHTTPHeaderField: "X-Organization-Id") }
    let response = try await http.send(request)
    try Task.checkCancellation()
    guard response.status == 200 else { throw UploadFailure.http(response.status) }
    guard response.body.count <= 16384 else { throw UploadFailure.invalidDocument }
    return try Self.scalarStatus(response.body)
  }
  static func scalarStatus(_ body: Data) throws -> String {
    let strings: Set<String> = ["profile", "recording_id", "session_id", "writer_epoch", "revision", "state"]
    let numbers: Set<String> = ["recording_generation", "received_count", "contiguous_sequence"]
    guard let object = try JSONSerialization.jsonObject(with: body) as? [String: Any],
      Set(object.keys) == strings.union(numbers).union(["expected_count", "authorization_expired"]),
      strings.allSatisfy({ (object[$0] as? String).map { $0.utf8.count <= 160 } == true }),
      numbers.allSatisfy({ isNumber(object[$0]) }),
      object["expected_count"] is NSNull || isNumber(object["expected_count"]),
      let expired = object["authorization_expired"] as? NSNumber,
      CFGetTypeID(expired) == CFBooleanGetTypeID() else { throw UploadFailure.invalidDocument }
    return String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
  }
  private static func isNumber(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber else { return false }
    return CFGetTypeID(number) != CFBooleanGetTypeID()
  }
}
