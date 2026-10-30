import Foundation

public enum WatchControlError: Error, Equatable, Sendable {
  case invalidConfiguration, invalidIdentifier, requestPreparationFailed, endpointMismatch
  case invalidResponse, requestExpired, invalidHeaders
  case http(Int)
  case networkUnavailable
}

/// Select the read-only route already exposed by the customer's backend.
public enum WatchCommandLookup: Sendable {
  case list, detail
}

public struct WatchConfiguration: Sendable {
  public let baseURL: URL
  public let devicesPath: String
  public let commandLookup: WatchCommandLookup

  public init(
    baseURL: URL, devicesPath: String = "/devices", commandLookup: WatchCommandLookup = .list
  ) throws {
    guard let parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
      parts.scheme == "https", parts.host?.isEmpty == false,
      parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
      devicesPath.hasPrefix("/"), !devicesPath.hasSuffix("/"),
      devicesPath.split(separator: "/", omittingEmptySubsequences: false).dropFirst().allSatisfy({
        validID(String($0))
      }), !baseURL.pathComponents.contains("..")
    else { throw WatchControlError.invalidConfiguration }
    self.baseURL = baseURL
    self.devicesPath = devicesPath
    self.commandLookup = commandLookup
  }

  var endpoint: WatchEndpoint {
    .init(baseURL: baseURL.absoluteString, devicesPath: devicesPath)
  }
}

public struct WatchEndpoint: Codable, Equatable, Sendable {
  public let baseURL: String
  public let devicesPath: String
}

public enum RecordingAction: String, Codable, Sendable {
  case startRecording = "start_recording"
  case stopRecording = "stop_recording"
}

public struct RecordingIntent: Codable, Equatable, Sendable, Identifiable {
  public let id: String
  public let endpoint: WatchEndpoint
  public let deviceID: String
  public let action: RecordingAction
  public let createdAt: Date
  public let expiresAt: Date
}

public enum WatchCommandStatus: String, Codable, Sendable {
  case pending, delivered, executed, failed, expired, cancelled
}

/// Only scalar presentation fields are decoded. Grants and raw error messages are discarded.
public struct WatchCommand: Codable, Equatable, Sendable, Identifiable {
  public let id: String
  public let deviceID: String
  public let type: String
  public let status: WatchCommandStatus
  public let expiresAt: String?
  public let executedAt: String?
  public let params: Parameters?
  public struct Parameters: Codable, Equatable, Sendable {
    public let metadata: Metadata?
    public struct Metadata: Codable, Equatable, Sendable {
      public let watchRequestID: String?
      enum CodingKeys: String, CodingKey { case watchRequestID = "watch_request_id" }
    }
  }
  enum CodingKeys: String, CodingKey {
    case id, type, status, params
    case deviceID = "device_id"
    case expiresAt = "expires_at"
    case executedAt = "executed_at"
  }
}

public struct WatchDevice: Codable, Equatable, Sendable, Identifiable {
  public let id: String
  public let name: String?
  public var displayName: String { name?.isEmpty == false ? name! : id }
}

public struct WatchDeviceState: Codable, Equatable, Sendable {
  public let deviceID: String
  public let lastHeartbeatAt: String?
  public let batteryPercent: Int?
  public let recordingState: RecordingState?
  public struct RecordingState: Codable, Equatable, Sendable {
    public let deviceState: String?
    public let recordingID: String?
    public let startedAt: String?
    enum CodingKeys: String, CodingKey {
      case deviceState = "device_state"
      case recordingID = "recording_id"
      case startedAt = "started_at"
    }
  }
  enum CodingKeys: String, CodingKey {
    case deviceID = "device_id"
    case lastHeartbeatAt = "last_heartbeat_at"
    case batteryPercent = "battery_percent"
    case recordingState = "recording_state"
  }
  public var observedAt: Date? { lastHeartbeatAt.flatMap(parseCloudDate) }
  public var startedAt: Date? { recordingState?.startedAt.flatMap(parseCloudDate) }

}

public struct WatchPage<Element: Decodable & Sendable>: Decodable, Sendable {
  public let data: [Element]
  public let hasMore: Bool?
  public let nextCursor: String?
  enum CodingKeys: String, CodingKey {
    case data
    case hasMore = "has_more"
    case nextCursor = "next_cursor"
  }
}

func validID(_ value: String) -> Bool {
  !value.isEmpty && value.utf8.count <= 128
    && value.utf8.allSatisfy {
      (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45
        || $0 == 95
    }
}

func parseCloudDate(_ value: String) -> Date? {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let date = formatter.date(from: value) { return date }
  formatter.formatOptions = [.withInternetDateTime]
  return formatter.date(from: value)
}
