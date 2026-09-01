import Foundation

struct BotaDeviceSDKAppleRecordingUploadRequest: Sendable {
    let taskID: String
    let recordingID: String
    let localPath: String
    let uploadURL: String
    let uploadToken: String?
    let completeURL: String?
    let contentType: String?
    let contentSHA256: String?
    let relayURL: String?
    let relayBearerToken: String?
}

struct BotaDeviceSDKAppleRecordingUploadProgress: Equatable, Sendable {
    let taskID: String
    let completedBytes: Int64
    let totalBytes: Int64
}

actor BotaDeviceSDKAppleRecordingUploads {
    private enum UploadError: LocalizedError {
        case alreadyActive(String)
        case invalidResponse
        case missingFile(String)
        case requestFailed(Int)

        var errorDescription: String? {
            switch self {
            case let .alreadyActive(taskID):
                "recording upload is already active: \(taskID)"
            case .invalidResponse:
                "recording upload returned an invalid HTTP response"
            case let .missingFile(path):
                "recording file does not exist: \(path)"
            case let .requestFailed(statusCode):
                "recording upload failed with HTTP \(statusCode)"
            }
        }
    }

    private var queueFile: URL
    private let session: URLSession
    private var operations: [String: Task<Void, Error>] = [:]

    init(
        queueFile: URL = BotaDeviceSDKAppleRecordingUploads.defaultQueueFile(),
        session: URLSession = .shared
    ) {
        self.queueFile = queueFile
        self.session = session
    }

    func configure(applicationSupportDirectory: URL?) {
        guard let applicationSupportDirectory else { return }
        queueFile = applicationSupportDirectory
            .appendingPathComponent("BotaDeviceSDK", isDirectory: true)
            .appendingPathComponent("compat-upload-queue.json")
    }

    func upload(
        _ upload: BotaDeviceSDKAppleRecordingUploadRequest,
        onProgress: @escaping @Sendable (BotaDeviceSDKAppleRecordingUploadProgress) -> Void
    ) async throws {
        guard operations[upload.taskID] == nil else {
            throw UploadError.alreadyActive(upload.taskID)
        }
        let session = session
        let operation = Task {
            try await Self.performUpload(upload, session: session, onProgress: onProgress)
        }
        operations[upload.taskID] = operation
        defer { operations.removeValue(forKey: upload.taskID) }
        try await operation.value
    }

    func cancel(taskID: String) {
        operations.removeValue(forKey: taskID)?.cancel()
    }

    func cancelAll() {
        operations.values.forEach { $0.cancel() }
        operations.removeAll()
    }

    func loadQueue() throws -> String {
        guard FileManager.default.fileExists(atPath: queueFile.path) else { return "[]" }
        return try String(contentsOf: queueFile, encoding: .utf8)
    }

    func saveQueue(_ serializedTasks: String) throws {
        try FileManager.default.createDirectory(
            at: queueFile.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(serializedTasks.utf8).write(to: queueFile, options: .atomic)
    }

    private static func performUpload(
        _ upload: BotaDeviceSDKAppleRecordingUploadRequest,
        session: URLSession,
        onProgress: @escaping @Sendable (BotaDeviceSDKAppleRecordingUploadProgress) -> Void
    ) async throws {
        let fileURL = URL(fileURLWithPath: upload.localPath)
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            throw UploadError.missingFile(upload.localPath)
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let totalBytes = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        onProgress(.init(taskID: upload.taskID, completedBytes: 0, totalBytes: totalBytes))

        let relay = upload.relayURL != nil
        let destination = try Self.requiredURL(upload.relayURL ?? upload.uploadURL)
        var request = URLRequest(url: destination)
        request.httpMethod = relay ? "POST" : "PUT"
        request.setValue(
            relay ? "application/octet-stream" : (upload.contentType ?? "audio/opus"),
            forHTTPHeaderField: "Content-Type"
        )
        if relay, let token = upload.relayBearerToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (_, response) = try await session.upload(for: request, fromFile: fileURL)
        try Self.requireSuccess(response)

        if !relay,
           let completeURL = upload.completeURL,
           let uploadToken = upload.uploadToken
        {
            var completeRequest = URLRequest(url: try requiredURL(completeURL))
            completeRequest.httpMethod = "POST"
            completeRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            completeRequest.setValue(
                "Bearer \(uploadToken)",
                forHTTPHeaderField: "Authorization"
            )
            var body: [String: String] = ["recording_id": upload.recordingID]
            if let contentSHA256 = upload.contentSHA256 {
                body["content_sha256"] = contentSHA256
            }
            completeRequest.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (_, completeResponse) = try await session.data(for: completeRequest)
            try requireSuccess(completeResponse)
        }

        onProgress(.init(
            taskID: upload.taskID,
            completedBytes: totalBytes,
            totalBytes: totalBytes
        ))
        try FileManager.default.removeItem(at: fileURL)
    }

    private static func requiredURL(_ value: String) throws -> URL {
        guard let url = URL(string: value) else { throw UploadError.invalidResponse }
        return url
    }

    private static func requireSuccess(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else {
            throw UploadError.invalidResponse
        }
        guard (200 ... 299).contains(http.statusCode) else {
            throw UploadError.requestFailed(http.statusCode)
        }
    }

    private static func defaultQueueFile() -> URL {
        let base = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        return base
            .appendingPathComponent("BotaDeviceSDK", isDirectory: true)
            .appendingPathComponent("compat-upload-queue.json")
    }
}
