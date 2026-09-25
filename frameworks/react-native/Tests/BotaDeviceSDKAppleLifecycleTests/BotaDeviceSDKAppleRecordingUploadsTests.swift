import Foundation
import XCTest
@testable import BotaDeviceSDKAppleAdapter

final class BotaDeviceSDKAppleRecordingUploadsTests: XCTestCase {
    override func tearDown() {
        RecordingUploadURLProtocol.reset()
        super.tearDown()
    }

    func testPlaintextUploadRetainsNativeFileUntilDurableHostCompletion() async throws {
        let fixture = try UploadFixture()
        RecordingUploadURLProtocol.enqueue(statusCode: 200)
        RecordingUploadURLProtocol.enqueue(statusCode: 204)
        let uploads = BotaDeviceSDKAppleRecordingUploads(
            queueFile: fixture.queueFile,
            session: Self.stubbedSession()
        )
        let progress = UploadProgressCapture()

        try await uploads.upload(.init(
            taskID: "task-1",
            recordingID: "rec-1",
            localPath: fixture.recordingFile.path,
            uploadURL: "https://s3.example/recording",
            uploadToken: "up-token",
            completeURL: "https://api.example/complete",
            contentType: "audio/ogg",
            contentSHA256: "abc123",
            relayURL: nil,
            relayBearerToken: nil
        )) { value in
            Task { await progress.append(value) }
        }

        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.recordingFile.path))
        XCTAssertEqual(
            RecordingUploadURLProtocol.requests(),
            [
                .init(method: "PUT", url: "https://s3.example/recording", authorization: nil),
                .init(
                    method: "POST",
                    url: "https://api.example/complete",
                    authorization: "Bearer up-token"
                ),
            ]
        )
        let values = await progress.snapshot()
        XCTAssertEqual(values.map(\.completedBytes), [0, 4])
        XCTAssertEqual(values.map(\.totalBytes), [4, 4])
    }

    func testEncryptedUploadUsesRelayAndSkipsCompletion() async throws {
        let fixture = try UploadFixture()
        RecordingUploadURLProtocol.enqueue(statusCode: 200)
        let uploads = BotaDeviceSDKAppleRecordingUploads(
            queueFile: fixture.queueFile,
            session: Self.stubbedSession()
        )

        try await uploads.upload(.init(
            taskID: "task-2",
            recordingID: "rec-2",
            localPath: fixture.recordingFile.path,
            uploadURL: "https://s3.example/unused",
            uploadToken: "up-token",
            completeURL: "https://api.example/unused",
            contentType: "audio/ogg",
            contentSHA256: nil,
            relayURL: "https://api.example/upload-relay",
            relayBearerToken: "device-token"
        )) { _ in }

        XCTAssertEqual(
            RecordingUploadURLProtocol.requests(),
            [
                .init(
                    method: "POST",
                    url: "https://api.example/upload-relay",
                    authorization: "Bearer device-token"
                ),
            ]
        )
    }

    func testQueueSaveAtomicallyReplacesExistingMetadata() async throws {
        let fixture = try UploadFixture()
        let uploads = BotaDeviceSDKAppleRecordingUploads(
            queueFile: fixture.queueFile,
            session: Self.stubbedSession()
        )

        try await uploads.saveQueue(fixture.journal(status: "pending"))
        try await uploads.saveQueue(fixture.journal(status: "failed"))

        let stored = try await uploads.loadQueue()
        let tasks = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(stored.utf8)) as? [[String: Any]])
        XCTAssertEqual(tasks.count, 1)
        XCTAssertEqual(tasks[0]["status"] as? String, "failed")
    }

    func testReleaseRequiresExactCompletedJournalAndIsIdempotent() async throws {
        let fixture = try UploadFixture()
        let uploads = BotaDeviceSDKAppleRecordingUploads(queueFile: fixture.queueFile)
        try await uploads.saveQueue(fixture.journal(status: "uploading"))
        do {
            try await uploads.release(taskID: "task-1", localPath: fixture.recordingFile.path)
            XCTFail("pending uploads must retain files")
        } catch {}
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.recordingFile.path))
        try await uploads.saveQueue(fixture.journal(status: "completed"))
        do {
            try await uploads.release(taskID: "other-task", localPath: fixture.recordingFile.path)
            XCTFail("a different task cannot release a file")
        } catch {}
        try await uploads.release(taskID: "task-1", localPath: fixture.recordingFile.path)
        try await uploads.release(taskID: "task-1", localPath: fixture.recordingFile.path)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.recordingFile.path))
    }

    func testLoadIsReadOnlyUntilValidatedSaveAndRelease() async throws {
        let fixture = try UploadFixture()
        try Data(fixture.journal(status: "completed").utf8).write(to: fixture.queueFile)
        let uploads = BotaDeviceSDKAppleRecordingUploads(queueFile: fixture.queueFile)
        let value = try await uploads.loadQueue()
        XCTAssertEqual(value, fixture.journal(status: "completed"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.recordingFile.path))
        try await uploads.saveQueue(value)
        try await uploads.release(taskID: "task-1", localPath: fixture.recordingFile.path)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.recordingFile.path))
        XCTAssertFalse(try String(contentsOf: fixture.queueFile, encoding: .utf8).contains("secret"))
    }

    func testCorruptJournalIsNotOverwritten() async throws {
        let fixture = try UploadFixture()
        try Data("{broken".utf8).write(to: fixture.queueFile)
        let uploads = BotaDeviceSDKAppleRecordingUploads(queueFile: fixture.queueFile)
        let loaded = try await uploads.loadQueue()
        XCTAssertEqual(loaded, "{broken")
        XCTAssertEqual(try String(contentsOf: fixture.queueFile, encoding: .utf8), "{broken")
    }

    func testParseableInvalidJournalNeverMutatesOrDeletesFiles() async throws {
        for (old, invalid) in [
            ("\"retryCount\":0", "\"retryCount\":-1"),
            ("\"createdAt\":\"2026-09-24T00:00:00Z\"", "\"createdAt\":\"invalid\""),
            ("\"status\":\"completed\"", "\"status\":\"completed\",\"fileSizeBytes\":\"4\""),
            ("\"status\":\"completed\"", "\"status\":\"completed\",\"recoveryScope\":123"),
        ] {
            let fixture = try UploadFixture()
            let contents = fixture.journal(status: "completed").replacingOccurrences(of: old, with: invalid)
            try Data(contents.utf8).write(to: fixture.queueFile)
            let uploads = BotaDeviceSDKAppleRecordingUploads(queueFile: fixture.queueFile)
            let loaded = try await uploads.loadQueue()
            XCTAssertEqual(loaded, contents)
            do { try await uploads.saveQueue(contents); XCTFail("invalid journal saved") } catch {}
            XCTAssertEqual(try String(contentsOf: fixture.queueFile, encoding: .utf8), contents)
            XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.recordingFile.path))
        }
    }

    func testDirectorySyncFailurePreventsRelease() async throws {
        let fixture = try UploadFixture()
        let uploads = BotaDeviceSDKAppleRecordingUploads(queueFile: fixture.queueFile, syncDirectory: { directory in
            if directory == fixture.queueFile.deletingLastPathComponent() { throw CocoaError(.fileWriteUnknown) }
        })
        do { try await uploads.saveQueue(fixture.journal(status: "completed")); XCTFail("directory sync failure ignored") } catch {}
        do { try await uploads.release(taskID: "task-1", localPath: fixture.recordingFile.path); XCTFail("uncertain journal released file") } catch {}
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.recordingFile.path))
    }

    func testCleanupDirectorySyncFailureRetainsJournalAndRetriesMissingFile() async throws {
        let fixture = try UploadFixture()
        let uploads = BotaDeviceSDKAppleRecordingUploads(queueFile: fixture.queueFile, syncDirectory: { directory in
            if directory == fixture.recordingFile.deletingLastPathComponent() { throw CocoaError(.fileWriteUnknown) }
        })
        try await uploads.saveQueue(fixture.journal(status: "completed"))
        let journal = try String(contentsOf: fixture.queueFile, encoding: .utf8)

        for _ in 0..<2 {
            do {
                try await uploads.release(taskID: "task-1", localPath: fixture.recordingFile.path)
                XCTFail("cleanup directory sync failure ignored")
            } catch {
                XCTAssertEqual((error as NSError).domain, NSCocoaErrorDomain)
                XCTAssertEqual((error as NSError).code, CocoaError.fileWriteUnknown.rawValue)
            }
            XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.recordingFile.path))
            XCTAssertEqual(try String(contentsOf: fixture.queueFile, encoding: .utf8), journal)
        }

        let restarted = BotaDeviceSDKAppleRecordingUploads(queueFile: fixture.queueFile)
        try await restarted.release(taskID: "task-1", localPath: fixture.recordingFile.path)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.recordingFile.path))
        XCTAssertEqual(try String(contentsOf: fixture.queueFile, encoding: .utf8), journal)
    }

    func testCancelledAttemptCannotStartLate() async throws {
        let fixture = try UploadFixture()
        let uploads = BotaDeviceSDKAppleRecordingUploads(queueFile: fixture.queueFile, session: Self.stubbedSession())
        RecordingUploadURLProtocol.enqueue(statusCode: 200)
        await uploads.cancel(taskID: "cancelled-attempt")
        do {
            try await uploads.upload(.init(
                taskID: "cancelled-attempt", recordingID: "rec-1", localPath: fixture.recordingFile.path,
                uploadURL: "https://s3.example/upload", uploadToken: nil, completeURL: nil,
                contentType: nil, contentSHA256: nil, relayURL: nil, relayBearerToken: nil
            )) { _ in }
            XCTFail("cancelled attempt started")
        } catch {}
        XCTAssertTrue(RecordingUploadURLProtocol.requests().isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.recordingFile.path))
    }

    func testReleaseNeverRecursivelyDeletesADirectory() async throws {
        let fixture = try UploadFixture()
        let uploads = BotaDeviceSDKAppleRecordingUploads(queueFile: fixture.queueFile)
        let child = fixture.directory.appendingPathComponent("must-retain", isDirectory: true)
        try FileManager.default.createDirectory(at: child, withIntermediateDirectories: true)
        try await uploads.saveQueue(fixture.journal(status: "completed").replacingOccurrences(of: fixture.recordingFile.path, with: child.path))
        do { try await uploads.release(taskID: "task-1", localPath: child.path); XCTFail("directory removed") } catch {}
        XCTAssertTrue(FileManager.default.fileExists(atPath: child.path))
    }

    func testCompletedJournalCannotReleaseForeignFile() async throws {
        let fixture = try UploadFixture()
        let uploads = BotaDeviceSDKAppleRecordingUploads(queueFile: fixture.queueFile)
        let foreign = fixture.directory.appendingPathComponent(UUID().uuidString + ".recording")
        try Data([9]).write(to: foreign)
        try await uploads.saveQueue(fixture.journal(status: "completed").replacingOccurrences(of: fixture.recordingFile.path, with: foreign.path))
        do { try await uploads.release(taskID: "task-1", localPath: foreign.path); XCTFail("foreign file removed") } catch {}
        XCTAssertTrue(FileManager.default.fileExists(atPath: foreign.path))
    }

    private static func stubbedSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RecordingUploadURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

private struct UploadFixture {
    let directory: URL
    let recordingFile: URL
    let queueFile: URL

    init() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let recordings = directory.appendingPathComponent("Recordings", isDirectory: true)
        try FileManager.default.createDirectory(at: recordings, withIntermediateDirectories: true)
        recordingFile = recordings.appendingPathComponent(UUID().uuidString + ".recording")
        queueFile = directory.appendingPathComponent("queue.json")
        try Data([1, 2, 3, 4]).write(to: recordingFile)
    }

    func journal(status: String) -> String {
        """
        [{"id":"task-1","recordingId":"rec-1","deviceId":"device-1","localPath":"\(recordingFile.path)","status":"\(status)","retryCount":0,"createdAt":"2026-09-24T00:00:00Z","updatedAt":"2026-09-24T00:00:00Z","uploadUrl":"https://secret","uploadToken":"secret","completeUrl":"https://secret","errorMessage":"secret","relay":{"url":"https://secret","bearerToken":"secret"}}]
        """
    }
}

private actor UploadProgressCapture {
    private var values: [BotaDeviceSDKAppleRecordingUploadProgress] = []

    func append(_ value: BotaDeviceSDKAppleRecordingUploadProgress) {
        values.append(value)
    }

    func snapshot() -> [BotaDeviceSDKAppleRecordingUploadProgress] {
        values
    }
}

private struct CapturedUploadRequest: Equatable, Sendable {
    let method: String
    let url: String
    let authorization: String?
}

private final class RecordingUploadURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var statusCodes: [Int] = []
    nonisolated(unsafe) private static var capturedRequests: [CapturedUploadRequest] = []

    static func enqueue(statusCode: Int) {
        lock.lock()
        statusCodes.append(statusCode)
        lock.unlock()
    }

    static func requests() -> [CapturedUploadRequest] {
        lock.lock()
        defer { lock.unlock() }
        return capturedRequests
    }

    static func reset() {
        lock.lock()
        statusCodes = []
        capturedRequests = []
        lock.unlock()
    }

    override class func canInit(with _: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        let statusCode = Self.statusCodes.removeFirst()
        Self.capturedRequests.append(.init(
            method: request.httpMethod ?? "",
            url: request.url?.absoluteString ?? "",
            authorization: request.value(forHTTPHeaderField: "Authorization")
        ))
        Self.lock.unlock()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
