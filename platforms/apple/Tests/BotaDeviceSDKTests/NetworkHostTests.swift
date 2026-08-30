import BotaDeviceSDKC
import Foundation
import XCTest

@testable import BotaDeviceSDK

final class NetworkHostTests: XCTestCase {
    override func tearDown() {
        URLProtocolStub.state.reset()
        super.tearDown()
    }

    func testDownloadUsesRegisteredRequestAndEmitsMonotonicProgress() async throws {
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: destination) }
        URLProtocolStub.state.responseData = Data("firmware".utf8)
        let host = URLSessionNetworkHost(configuration: configuration())
        await host.registerDownload(
            id: 7,
            request: URLRequest(url: URL(string: "https://example.test/firmware")!),
            destinationURL: destination
        )

        let events = try await Self.collect(await host.execute(effect(
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_NETWORK_DOWNLOAD),
            fields: [.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DOWNLOAD_ID), value: 7)]
        )))
        let completed = events.compactMap { $0.unsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMPLETED_UNITS)) }

        XCTAssertEqual(try Data(contentsOf: destination), Data("firmware".utf8))
        XCTAssertEqual(completed, completed.sorted())
        XCTAssertEqual(completed.first, 0)
        XCTAssertEqual(completed.last, UInt64(Data("firmware".utf8).count))
        XCTAssertEqual(events.last?.kind, UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_NETWORK_DOWNLOAD_COMPLETED))
    }

    func testUploadReadsOnlyTheRegisteredSource() async throws {
        let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: source) }
        try Data("recording".utf8).write(to: source)
        let host = URLSessionNetworkHost(configuration: configuration())
        var request = URLRequest(url: URL(string: "https://example.test/upload")!)
        request.httpMethod = "PUT"
        await host.registerUpload(id: 11, request: request, sourceURL: source)

        let events = try await Self.collect(await host.execute(effect(
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_NETWORK_UPLOAD),
            fields: [
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_UPLOAD_ID), value: 11),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_UPLOAD_SOURCE), value: 1),
            ]
        )))

        XCTAssertEqual(URLProtocolStub.state.lastRequest?.httpMethod, "PUT")
        XCTAssertEqual(events.last?.kind, UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_NETWORK_UPLOAD_COMPLETED))
    }

    func testCancellingConsumerCancelsURLSessionRequest() async throws {
        URLProtocolStub.state.responseDelay = 1
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: destination) }
        let host = URLSessionNetworkHost(configuration: configuration())
        await host.registerDownload(
            id: 13,
            request: URLRequest(url: URL(string: "https://example.test/slow")!),
            destinationURL: destination
        )
        let networkEffect = effect(
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_NETWORK_DOWNLOAD),
            fields: [.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DOWNLOAD_ID), value: 13)]
        )
        let empty = EmptyHostPort()
        let executor = HostEffectExecutor(
            bluetooth: empty,
            persistence: empty,
            network: host,
            material: empty,
            recordingSink: empty,
            firmwareBlob: empty
        )
        _ = await executor.execute(networkEffect)
        try await waitUntil { URLProtocolStub.state.lastRequest != nil }

        await executor.cancel(networkEffect.cancellationID)
        try await waitUntil { URLProtocolStub.state.stopCount > 0 }

        XCTAssertGreaterThan(URLProtocolStub.state.stopCount, 0)
    }

    func testHTTPStatusIsPreservedInNetworkFailureEvent() async throws {
        URLProtocolStub.state.statusCode = 403
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: destination) }
        let host = URLSessionNetworkHost(configuration: configuration())
        await host.registerDownload(
            id: 17,
            request: URLRequest(url: URL(string: "https://example.test/forbidden")!),
            destinationURL: destination
        )
        let empty = EmptyHostPort()
        let executor = HostEffectExecutor(
            bluetooth: empty,
            persistence: empty,
            network: host,
            material: empty,
            recordingSink: empty,
            firmwareBlob: empty
        )
        let stream = await executor.execute(effect(
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_NETWORK_DOWNLOAD),
            fields: [.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DOWNLOAD_ID), value: 17)]
        ))
        var events: [CoreHostEvent] = []
        for try await event in stream { events.append(event) }

        XCTAssertEqual(events.last?.kind, UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_NETWORK_FAILED))
        XCTAssertEqual(events.last?.fields.unsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_TRANSFER_ID)), 17)
        XCTAssertEqual(events.last?.fields.unsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_STATUS_CODE)), 403)
    }

    private func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [URLProtocolStub.self]
        return configuration
    }

    private func effect(_ kind: UInt32, fields: [CoreField]) -> CoreEffect {
        try! CoreEffect(packet: CorePacket(
            kind: kind,
            operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_UPDATE_FIRMWARE),
            requestID: 1,
            cancellationHigh: 1,
            cancellationLow: 2,
            fields: fields
        ))
    }

    private static func collect(
        _ stream: AsyncThrowingStream<CoreHostEventPayload, Error>
    ) async throws -> [CoreHostEventPayload] {
        var values: [CoreHostEventPayload] = []
        for try await value in stream { values.append(value) }
        return values
    }

    private func waitUntil(
        timeoutNanoseconds: UInt64 = 500_000_000,
        condition: @escaping @Sendable () -> Bool
    ) async throws {
        let deadline = ContinuousClock.now + .nanoseconds(Int64(timeoutNanoseconds))
        while !condition() {
            if ContinuousClock.now >= deadline { throw URLError(.timedOut) }
            await Task.yield()
        }
    }
}

private struct EmptyHostPort: BluetoothHost, PersistenceHost, MaterialHost, RecordingSinkHost, FirmwareBlobHost {
    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        AsyncThrowingStream { $0.finish() }
    }
}

private final class URLProtocolStub: URLProtocol, @unchecked Sendable {
    static let state = URLProtocolState()
    private let lock = NSLock()
    private var stopped = false

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.state.record(request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: Self.state.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Length": "\(Self.state.responseData.count)"]
        )!
        let finish: @Sendable () -> Void = { [self] in
            guard !lock.withLock({ stopped }) else { return }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            let data = Self.state.responseData
            let split = data.count / 2
            client?.urlProtocol(self, didLoad: data.prefix(split))
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.01) { [self] in
                guard !lock.withLock({ stopped }) else { return }
                client?.urlProtocol(self, didLoad: data.suffix(from: split))
                client?.urlProtocolDidFinishLoading(self)
            }
        }
        let delay = Self.state.responseDelay
        if delay > 0 {
            DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: finish)
        } else {
            finish()
        }
    }

    override func stopLoading() {
        lock.withLock { stopped = true }
        Self.state.recordStop()
    }
}

private final class URLProtocolState: @unchecked Sendable {
    private let lock = NSLock()
    private var storageResponseData = Data()
    private var storageStatusCode = 200
    private var storageResponseDelay: TimeInterval = 0
    private var storageLastRequest: URLRequest?
    private var storageStopCount = 0

    var responseData: Data {
        get { lock.withLock { storageResponseData } }
        set { lock.withLock { storageResponseData = newValue } }
    }
    var statusCode: Int {
        get { lock.withLock { storageStatusCode } }
        set { lock.withLock { storageStatusCode = newValue } }
    }
    var responseDelay: TimeInterval {
        get { lock.withLock { storageResponseDelay } }
        set { lock.withLock { storageResponseDelay = newValue } }
    }
    var lastRequest: URLRequest? { lock.withLock { storageLastRequest } }
    var stopCount: Int { lock.withLock { storageStopCount } }

    func record(_ request: URLRequest) { lock.withLock { storageLastRequest = request } }
    func recordStop() { lock.withLock { storageStopCount += 1 } }
    func reset() {
        lock.withLock {
            storageResponseData = Data()
            storageStatusCode = 200
            storageResponseDelay = 0
            storageLastRequest = nil
            storageStopCount = 0
        }
    }
}

private extension CoreHostEventPayload {
    func unsigned(_ id: UInt32) -> UInt64? {
        for field in fields {
            if case let .unsigned(fieldID, value) = field, fieldID == id { return value }
        }
        return nil
    }
}
