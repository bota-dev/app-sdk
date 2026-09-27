import Foundation
import Darwin

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
    var fileSizeBytes: Int64? = nil
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
        case invalidJournal
        case notCompleted
        case fileSizeChanged

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
            case .invalidJournal:
                "invalid upload recovery journal"
            case .notCompleted:
                "recording release requires exact durable completion"
            case .fileSizeChanged:
                "stored recording length changed"
            }
        }
    }

    private var queueFile: URL
    private var recordingDirectory: URL
    private let session: URLSession
    private let syncDirectory: @Sendable (URL) throws -> Void
    private var journalWriteUncertain = false
    private var operations: [String: Task<Void, Error>] = [:]
    private var cancelledAttempts = Set<String>()

    init(
        queueFile: URL = BotaDeviceSDKAppleRecordingUploads.defaultQueueFile(),
        session: URLSession = .shared,
        syncDirectory: @escaping @Sendable (URL) throws -> Void = BotaDeviceSDKAppleRecordingUploads.synchronizeDirectory
    ) {
        self.queueFile = queueFile
        recordingDirectory = queueFile.deletingLastPathComponent().appendingPathComponent("Recordings", isDirectory: true)
        self.session = session
        self.syncDirectory = syncDirectory
    }

    func configure(applicationSupportDirectory: URL?) {
        guard let applicationSupportDirectory else {
            queueFile = Self.defaultQueueFile()
            recordingDirectory = queueFile.deletingLastPathComponent().appendingPathComponent("Recordings", isDirectory: true)
            return
        }
        recordingDirectory = applicationSupportDirectory.appendingPathComponent("Recordings", isDirectory: true)
        queueFile = applicationSupportDirectory
            .appendingPathComponent("BotaDeviceSDK", isDirectory: true)
            .appendingPathComponent("compat-upload-queue.json")
    }

    func upload(
        _ upload: BotaDeviceSDKAppleRecordingUploadRequest,
        onProgress: @escaping @Sendable (BotaDeviceSDKAppleRecordingUploadProgress) -> Void
    ) async throws {
        guard !cancelledAttempts.contains(upload.taskID) else { throw CancellationError() }
        try requireOwnedFile(upload.localPath)
        guard operations[upload.taskID] == nil else {
            throw UploadError.alreadyActive(upload.taskID)
        }
        let session = session
        let operation = Task {
            try await Self.performUpload(upload, session: session, onProgress: onProgress)
        }
        operations[upload.taskID] = operation
        defer { operations.removeValue(forKey: upload.taskID) }
        try await withTaskCancellationHandler {
            try await operation.value
        } onCancel: {
            operation.cancel()
        }
    }

    func cancel(taskID: String) {
        cancelledAttempts.insert(taskID)
        operations[taskID]?.cancel()
    }

    func cancelAll() {
        cancelledAttempts.formUnion(operations.keys)
        operations.values.forEach { $0.cancel() }
    }

    func loadQueue() throws -> String {
        guard FileManager.default.fileExists(atPath: queueFile.path) else { return "[]" }
        return try String(contentsOf: queueFile, encoding: .utf8)
    }

    func saveQueue(_ serializedTasks: String) throws {
        try writeQueue(Self.serialize(Self.metadata(serializedTasks)))
    }

    func release(taskID: String, localPath: String) async throws {
        guard !journalWriteUncertain else { throw UploadError.notCompleted }
        let tasks = try Self.metadata(String(contentsOf: queueFile, encoding: .utf8))
        guard tasks.contains(where: {
            $0["id"] as? String == taskID && $0["localPath"] as? String == localPath &&
                $0["status"] as? String == "completed"
        }) else { throw UploadError.notCompleted }
        try removeCompletedFile(localPath)
    }

    private func removeCompletedFile(_ path: String) throws {
        try requireOwnedFile(path)
        if FileManager.default.fileExists(atPath: path) {
            let attributes = try FileManager.default.attributesOfItem(atPath: path)
            guard attributes[.type] as? FileAttributeType == .typeRegular else { throw UploadError.notCompleted }
            try FileManager.default.removeItem(atPath: path)
        }
        // A missing file may be an earlier unlink whose directory sync failed.
        try syncDirectory(URL(fileURLWithPath: path).deletingLastPathComponent())
    }

    private func requireOwnedFile(_ path: String) throws {
        let file = URL(fileURLWithPath: path)
        guard path.hasPrefix("/"), file.pathExtension == "recording",
              UUID(uuidString: file.deletingPathExtension().lastPathComponent) != nil,
              file.resolvingSymlinksInPath().deletingLastPathComponent().standardizedFileURL == recordingDirectory.resolvingSymlinksInPath().standardizedFileURL
        else { throw UploadError.notCompleted }
        if FileManager.default.fileExists(atPath: path) {
            let attributes = try FileManager.default.attributesOfItem(atPath: path)
            guard attributes[.type] as? FileAttributeType == .typeRegular else { throw UploadError.notCompleted }
        }
    }

    private func writeQueue(_ serializedTasks: String) throws {
        journalWriteUncertain = true
        try FileManager.default.createDirectory(
            at: queueFile.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try syncDirectory(queueFile.deletingLastPathComponent().deletingLastPathComponent())
        try Data(serializedTasks.utf8).write(to: queueFile, options: .atomic)
        let handle = try FileHandle(forWritingTo: queueFile)
        defer { try? handle.close() }
        try handle.synchronize()
        try syncDirectory(queueFile.deletingLastPathComponent())
        journalWriteUncertain = false
    }

    private static func serialize(_ tasks: [[String: Any]]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: tasks, options: [.sortedKeys]), as: UTF8.self)
    }

    private static func metadata(_ serialized: String) throws -> [[String: Any]] {
        guard let tasks = try JSONSerialization.jsonObject(with: Data(serialized.utf8)) as? [[String: Any]] else {
            throw UploadError.invalidJournal
        }
        let fields: Set<String> = ["id", "recordingId", "deviceId", "recordingUuid", "localPath", "status", "retryCount", "createdAt", "updatedAt", "recoveryScope", "fileSizeBytes", "nextAttemptAt", "contentType", "contentSha256", "relayUpload"]
        var ids = Set<String>()
        return try tasks.map { task in
            guard let id = task["id"] as? String, !id.isEmpty, ids.insert(id).inserted,
                  let recordingID = task["recordingId"] as? String, !recordingID.isEmpty,
                  let deviceID = task["deviceId"] as? String, !deviceID.isEmpty,
                  task["localPath"] is String, task["createdAt"] is String, task["updatedAt"] is String,
                  let status = task["status"] as? String, ["pending", "uploading", "completed", "failed"].contains(status),
                  validInteger(task["retryCount"])
            else { throw UploadError.invalidJournal }
            for key in ["recordingUuid", "recoveryScope", "contentType", "contentSha256"] where task[key] != nil {
                guard task[key] is String else { throw UploadError.invalidJournal }
            }
            for key in ["fileSizeBytes", "nextAttemptAt"] where task[key] != nil {
                guard validInteger(task[key]) else { throw UploadError.invalidJournal }
            }
            if let relay = task["relayUpload"] {
                guard let number = relay as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw UploadError.invalidJournal }
            }
            let dates = ISO8601DateFormatter()
            let fractionalDates = ISO8601DateFormatter()
            fractionalDates.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            for key in ["createdAt", "updatedAt"] {
                guard let value = task[key] as? String,
                      dates.date(from: value) != nil || fractionalDates.date(from: value) != nil
                else { throw UploadError.invalidJournal }
            }
            var clean = task.filter { fields.contains($0.key) }
            guard clean.values.allSatisfy({ $0 is String || $0 is NSNumber }) else { throw UploadError.invalidJournal }
            clean["relayUpload"] = task["relayUpload"] as? Bool ?? (task["relay"] is [String: Any])
            return clean
        }
    }

    private static func validInteger(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        let value = number.doubleValue
        return value.isFinite && value >= 0 && value <= 9_007_199_254_740_991 && value.rounded() == value
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
        if let expected = upload.fileSizeBytes, expected != totalBytes { throw UploadError.fileSizeChanged }
        try Task.checkCancellation()
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
        try Task.checkCancellation()

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

        try Task.checkCancellation()
        onProgress(.init(
            taskID: upload.taskID,
            completedBytes: totalBytes,
            totalBytes: totalBytes
        ))
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

    private static func synchronizeDirectory(_ directory: URL) throws {
        let descriptor = Darwin.open(directory.path, O_RDONLY)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }
}
