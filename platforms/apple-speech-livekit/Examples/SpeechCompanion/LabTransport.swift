import Foundation

enum LabFailure: String, Error, Sendable {
    case invalidConfiguration, unavailable, unsupportedSession, conflict, closed
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

