import BotaDeviceSDKC
@preconcurrency import Foundation

actor URLSessionNetworkHost: NetworkHost {
    private struct Download: Sendable {
        let request: URLRequest
        let destinationURL: URL
    }

    private struct Upload: Sendable {
        let request: URLRequest
        let sourceURL: URL
    }

    private let transferDelegate: URLSessionTransferDelegate
    private let session: URLSession
    private var downloads: [UInt64: Download] = [:]
    private var uploads: [UInt64: Upload] = [:]

    init(configuration: URLSessionConfiguration = .ephemeral) {
        let transferDelegate = URLSessionTransferDelegate()
        self.transferDelegate = transferDelegate
        session = URLSession(configuration: configuration, delegate: transferDelegate, delegateQueue: nil)
    }

    func registerDownload(id: UInt64, request: URLRequest, destinationURL: URL) {
        downloads[id] = Download(request: request, destinationURL: destinationURL)
    }

    func registerUpload(id: UInt64, request: URLRequest, sourceURL: URL) {
        uploads[id] = Upload(request: request, sourceURL: sourceURL)
    }

    func unregister(id: UInt64) {
        downloads[id] = nil
        uploads[id] = nil
    }

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        let pair = AsyncThrowingStream<CoreHostEventPayload, Error>.makeStream()
        let task = Task {
            do {
                switch effect {
                case .networkDownload:
                    let id = try requiredUnsigned(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_DOWNLOAD_ID))
                    guard let download = downloads[id] else { throw NativeHostError.missingResource(String(id)) }
                    pair.continuation.yield(downloadProgress(id: id, completed: 0, total: nil))
                    let updates = transferDelegate.download(session: session, request: download.request)
                    var downloadedData = Data()
                    var response: URLResponse?
                    for try await update in updates {
                        switch update {
                        case let .progress(completed, total):
                            pair.continuation.yield(downloadProgress(id: id, completed: completed, total: total))
                        case let .completed(data, completedResponse):
                            downloadedData = data
                            response = completedResponse
                        }
                    }
                    guard let response else { throw URLError(.badServerResponse) }
                    try validate(response)
                    try downloadedData.write(to: download.destinationURL, options: .atomic)
                    pair.continuation.yield(.init(
                        kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_NETWORK_DOWNLOAD_COMPLETED),
                        fields: [.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DOWNLOAD_ID), value: id)]
                    ))
                case .networkUpload:
                    let id = try requiredUnsigned(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_UPLOAD_ID))
                    guard let upload = uploads[id] else { throw NativeHostError.missingResource(String(id)) }
                    let size = try fileSize(upload.sourceURL)
                    pair.continuation.yield(uploadProgress(id: id, completed: 0, total: size))
                    let updates = transferDelegate.upload(
                        session: session,
                        request: upload.request,
                        sourceURL: upload.sourceURL
                    )
                    var response: URLResponse?
                    var latestCompleted: UInt64 = 0
                    for try await update in updates {
                        switch update {
                        case let .progress(completed, total):
                            latestCompleted = max(latestCompleted, completed)
                            pair.continuation.yield(uploadProgress(id: id, completed: latestCompleted, total: total ?? size))
                        case let .completed(_, completedResponse):
                            response = completedResponse
                        }
                    }
                    guard let response else { throw URLError(.badServerResponse) }
                    try validate(response)
                    if latestCompleted < size {
                        pair.continuation.yield(uploadProgress(id: id, completed: size, total: size))
                    }
                    pair.continuation.yield(.init(
                        kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_NETWORK_UPLOAD_COMPLETED),
                        fields: [.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_UPLOAD_ID), value: id)]
                    ))
                default:
                    throw NativeHostError.invalidEffect(effect.kind)
                }
                pair.continuation.finish()
            } catch {
                pair.continuation.finish(throwing: error)
            }
        }
        pair.continuation.onTermination = { @Sendable _ in task.cancel() }
        return pair.stream
    }

    private func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else { throw NativeHostError.httpStatus(http.statusCode) }
    }

    private func fileSize(_ url: URL) throws -> UInt64 {
        UInt64(try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
    }

    private func downloadProgress(id: UInt64, completed: UInt64, total: UInt64?) -> CoreHostEventPayload {
        var fields: [CoreField] = [
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DOWNLOAD_ID), value: id),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMPLETED_UNITS), value: completed),
        ]
        if let total { fields.append(.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TOTAL_UNITS), value: total)) }
        return .init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_NETWORK_DOWNLOAD_PROGRESS), fields: fields)
    }

    private func uploadProgress(id: UInt64, completed: UInt64, total: UInt64) -> CoreHostEventPayload {
        .init(
            kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_NETWORK_UPLOAD_PROGRESS),
            fields: [
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_UPLOAD_ID), value: id),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMPLETED_UNITS), value: completed),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TOTAL_UNITS), value: total),
            ]
        )
    }
}

private enum URLSessionTransferUpdate: @unchecked Sendable {
    case progress(completed: UInt64, total: UInt64?)
    case completed(data: Data, response: URLResponse)
}

private final class URLSessionTransferDelegate: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate,
    @unchecked Sendable {
    private struct Transfer {
        let continuation: AsyncThrowingStream<URLSessionTransferUpdate, Error>.Continuation
        let collectsData: Bool
        var data = Data()
        var response: URLResponse?
    }

    private let lock = NSLock()
    private var transfers: [Int: Transfer] = [:]

    func download(
        session: URLSession,
        request: URLRequest
    ) -> AsyncThrowingStream<URLSessionTransferUpdate, Error> {
        let task = session.dataTask(with: request)
        return stream(task: task, collectsData: true)
    }

    func upload(
        session: URLSession,
        request: URLRequest,
        sourceURL: URL
    ) -> AsyncThrowingStream<URLSessionTransferUpdate, Error> {
        let task = session.uploadTask(with: request, fromFile: sourceURL)
        return stream(task: task, collectsData: false)
    }

    private func stream(
        task: URLSessionTask,
        collectsData: Bool
    ) -> AsyncThrowingStream<URLSessionTransferUpdate, Error> {
        let pair = AsyncThrowingStream<URLSessionTransferUpdate, Error>.makeStream()
        lock.withLock {
            transfers[task.taskIdentifier] = Transfer(
                continuation: pair.continuation,
                collectsData: collectsData
            )
        }
        pair.continuation.onTermination = { @Sendable _ in task.cancel() }
        task.resume()
        return pair.stream
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        lock.withLock { transfers[dataTask.taskIdentifier]?.response = response }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let update: (AsyncThrowingStream<URLSessionTransferUpdate, Error>.Continuation, UInt64, UInt64?)? =
            lock.withLock {
                guard var transfer = transfers[dataTask.taskIdentifier] else { return nil }
                if transfer.collectsData { transfer.data.append(data) }
                transfers[dataTask.taskIdentifier] = transfer
                let total = transfer.response.flatMap { response in
                    response.expectedContentLength >= 0 ? UInt64(response.expectedContentLength) : nil
                }
                return (transfer.continuation, UInt64(transfer.data.count), total)
            }
        if let update {
            update.0.yield(.progress(completed: update.1, total: update.2))
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        let continuation = lock.withLock { transfers[task.taskIdentifier]?.continuation }
        continuation?.yield(.progress(
            completed: UInt64(max(0, totalBytesSent)),
            total: totalBytesExpectedToSend >= 0 ? UInt64(totalBytesExpectedToSend) : nil
        ))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let transfer = lock.withLock({ transfers.removeValue(forKey: task.taskIdentifier) }) else { return }
        if let error {
            transfer.continuation.finish(throwing: error)
        } else if let response = transfer.response ?? task.response {
            transfer.continuation.yield(.completed(data: transfer.data, response: response))
            transfer.continuation.finish()
        } else {
            transfer.continuation.finish(throwing: URLError(.badServerResponse))
        }
    }
}
