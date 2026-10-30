import Foundation

public struct WatchHTTPResponse: Sendable {
  public let statusCode: Int
  public let data: Data
  public init(statusCode: Int, data: Data) {
    self.statusCode = statusCode
    self.data = data
  }
}

public protocol WatchHTTPTransport: Sendable {
  func send(_ request: URLRequest) async throws -> WatchHTTPResponse
}

/// Foreground, ephemeral HTTPS only. Never queue a start command as a background transfer.
public final class WatchURLSessionTransport: NSObject, WatchHTTPTransport, URLSessionTaskDelegate,
  Sendable
{
  public override init() { super.init() }

  public func send(_ request: URLRequest) async throws -> WatchHTTPResponse {
    guard request.url?.scheme == "https" else { throw WatchControlError.invalidConfiguration }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    configuration.timeoutIntervalForRequest = 15
    configuration.timeoutIntervalForResource = 20
    configuration.waitsForConnectivity = false
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    let (bytes, response) = try await session.bytes(for: request)
    guard let response = response as? HTTPURLResponse, response.url == request.url else {
      throw WatchControlError.invalidResponse
    }
    var data = Data()
    for try await byte in bytes {
      guard data.count < 1_048_576 else { throw WatchControlError.invalidResponse }
      data.append(byte)
    }
    return WatchHTTPResponse(statusCode: response.statusCode, data: data)
  }

  public func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    // Do not forward account credentials or replay commands to redirected origins.
    completionHandler(nil)
  }
}
