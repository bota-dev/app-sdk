import Foundation
import XCTest
@testable import BotaDeviceSDKAppleAdapter

final class BotaDeviceSDKAppleRecordingUploadsTests: XCTestCase {
    override func tearDown() {
        RecordingUploadURLProtocol.reset()
        super.tearDown()
    }

    func testPlaintextUploadUsesPutCompletesAndDeletesNativeFile() async throws {
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

        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.recordingFile.path))
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

        try await uploads.saveQueue("[{\"id\":\"first\"}]")
        try await uploads.saveQueue("[{\"id\":\"second\"}]")

        let stored = try await uploads.loadQueue()
        XCTAssertEqual(stored, "[{\"id\":\"second\"}]")
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
        recordingFile = directory.appendingPathComponent("recording.bin")
        queueFile = directory.appendingPathComponent("queue.json")
        try Data([1, 2, 3, 4]).write(to: recordingFile)
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
