import Foundation

struct UploadHTTPResponse: Sendable { let status: Int; let body: Data }

@MainActor protocol UploadHTTP {
  func send(_ request: URLRequest) async throws -> UploadHTTPResponse
}

// Refuse redirects so Cognito credentials and opaque bodies never change origin.
private final class UploadRedirectPolicy: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

@MainActor final class UploadURLSessionHTTP: UploadHTTP {
  private let session: URLSession

  init() {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 60
    session = URLSession(configuration: configuration, delegate: UploadRedirectPolicy(), delegateQueue: nil)
  }
  deinit { session.invalidateAndCancel() }

  func send(_ request: URLRequest) async throws -> UploadHTTPResponse {
    do {
      let (body, response) = try await session.data(for: request)
      guard let response = response as? HTTPURLResponse, body.count <= 1_048_576 else { throw UploadFailure.invalidDocument }
      return UploadHTTPResponse(status: response.statusCode, body: body)
    } catch { throw UploadFailure.safe(error) }
  }
}

@MainActor final class UploadCredentials {
  private struct Pending {
    let operationId: String
    let continuation: CheckedContinuation<String, Error>
    let timer: Task<Void, Never>
  }
  var emit: ((String, String) -> Void)?
  private var pending: [String: Pending] = [:]

  func request(operationId: String) async throws -> String {
    try Task.checkCancellation()
    let id = UUID().uuidString.lowercased()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let timer = Task {
          do { try await Task.sleep(nanoseconds: 30_000_000_000) }
          catch { return }
          self.reject(requestId: id)
        }
        pending[id] = Pending(operationId: operationId, continuation: continuation, timer: timer)
        emit?(id, operationId)
      }
    } onCancel: { Task { @MainActor in self.finish(id, result: .failure(UploadFailure.cancelled)) } }
  }

  func resolve(requestId: String, token: String) {
    guard !token.isEmpty, token.utf8.count <= 16_384,
          token.utf8.allSatisfy({ (33...126).contains($0) }) else { reject(requestId: requestId); return }
    finish(requestId, result: .success(token))
  }
  func reject(requestId: String) { finish(requestId, result: .failure(UploadFailure.http(401))) }
  func cancel(operationId: String) {
    for id in pending.filter({ $0.value.operationId == operationId }).map(\.key) {
      finish(id, result: .failure(UploadFailure.cancelled))
    }
  }
  private func finish(_ id: String, result: Result<String, Error>) {
    guard let request = pending.removeValue(forKey: id) else { return }
    request.timer.cancel()
    request.continuation.resume(with: result)
  }
}
