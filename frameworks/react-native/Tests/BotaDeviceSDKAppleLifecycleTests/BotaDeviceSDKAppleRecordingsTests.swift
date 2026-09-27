import BotaAppSDK
import Foundation
import XCTest
@testable import BotaDeviceSDKAppleAdapter

private actor BridgeNonceGate {
    private var continuation: CheckedContinuation<Data, Never>?
    private var released = false
    func read() async -> Data {
        if released { return Data(repeating: 1, count: 16) }
        return await withCheckedContinuation { continuation = $0 }
    }
    func release() {
        released = true
        continuation?.resume(returning: Data(repeating: 1, count: 16))
        continuation = nil
    }
}

private func bridgeV2Context(
    nonce: @escaping @Sendable () async throws -> Data
) -> EncryptedUploadV2ProviderContext {
    .init(
        recording: .init(uuid: "00112233-4455-6677-8899-aabbccddeeff", generation: 4,
                         ciphertextLength: 4_096, ciphertextSHA256: Data(repeating: 0x5a, count: 32)),
        capability: .init(rawValue: Data(), sha256: Data(repeating: 0x6b, count: 32),
                          capabilities: .init(flags: 0x17f, maximumSignedBlobBytes: 1_024,
                            maximumManifestBytes: 1_024, maximumDataPayloadBytes: 4_096,
                            maximumWindowPackets: 8, durableCheckpointIntervalBlocks: 256,
                            maximumMissingSequences: 16)),
        checkpoint: nil, readAuthNonce: nonce
    )
}

final class BotaDeviceSDKAppleRecordingsTests: XCTestCase {
    func testV2CancellationStopsExactPendingProviderAndClosesNonceContext() async throws {
        try await checkV2Cancellation(bulk: false)
    }

    func testV2BulkCancellationStopsExactPendingProviderAndClosesNonceContext() async throws {
        try await checkV2Cancellation(bulk: true)
    }

    private func checkV2Cancellation(bulk: Bool) async throws {
        let context = bridgeV2Context { Data(repeating: 1, count: 16) }
        let client = TestAppleRecordingClient(
            recording: DeviceRecording(uuid: "legacy", startedAt: .distantPast, durationMs: 0,
                                       fileSizeBytes: 0, codec: .known(.opus16k), isEncrypted: false),
            encryptedUploadV2Context: context
        )
        let recordings = BotaDeviceSDKAppleRecordings(client: client)
        let requested = expectation(description: "native profile requested")
        let operationID = UUID().uuidString
        let task = Task {
            try await recordings.syncEncryptedRecordingV2(
                connectedDevice(), recording: context.recording, operationID: operationID,
                onProfileRequest: { _ in requested.fulfill() }, onProgress: { _ in }
            )
        }
        await fulfillment(of: [requested], timeout: 5)
        let nonce = try await BotaDeviceSDKEncryptedUploadV2Materials.readAuthNonce(operationID)
        XCTAssertEqual(nonce, Data(repeating: 1, count: 16))
        if bulk { await recordings.cancelAll() }
        else { try await recordings.cancelEncryptedRecordingV2(operationID) }
        do { try await task.value; XCTFail("cancelled provider must not complete") }
        catch { XCTAssertTrue(error is CancellationError) }
        do {
            _ = try await BotaDeviceSDKEncryptedUploadV2Materials.readAuthNonce(operationID)
            XCTFail("closed operation must not read a nonce")
        } catch {}
    }

    func testV2NonceReadRejectsRemovedAndReplacedLease() async throws {
        let entered = expectation(description: "nonce read started")
        let gate = BridgeNonceGate()
        let operationID = UUID().uuidString
        try BotaDeviceSDKEncryptedUploadV2Materials.registerContext(operationID, context: bridgeV2Context {
            entered.fulfill()
            return await gate.read()
        })
        let task = Task { try await BotaDeviceSDKEncryptedUploadV2Materials.readAuthNonce(operationID) }
        await fulfillment(of: [entered], timeout: 5)
        BotaDeviceSDKEncryptedUploadV2Materials.removeContext(operationID)
        try BotaDeviceSDKEncryptedUploadV2Materials.registerContext(
            operationID, context: bridgeV2Context { Data(repeating: 2, count: 16) }
        )
        await gate.release()
        do { _ = try await task.value; XCTFail("replacement lease must reject old nonce") }
        catch {}
        BotaDeviceSDKEncryptedUploadV2Materials.removeContext(operationID)
    }

    func testV2PreCancelledOperationNeverRequestsMaterial() async throws {
        let context = bridgeV2Context { Data(repeating: 1, count: 16) }
        let client = TestAppleRecordingClient(
            recording: DeviceRecording(uuid: "legacy", startedAt: .distantPast, durationMs: 0,
                                       fileSizeBytes: 0, codec: .known(.opus16k), isEncrypted: false),
            encryptedUploadV2Context: context
        )
        let recordings = BotaDeviceSDKAppleRecordings(client: client)
        let operationID = UUID().uuidString
        try await recordings.cancelEncryptedRecordingV2(operationID)
        do {
            try await recordings.syncEncryptedRecordingV2(
                connectedDevice(), recording: context.recording, operationID: operationID,
                onProfileRequest: { _ in XCTFail("pre-cancelled operation requested material") },
                onProgress: { _ in XCTFail("pre-cancelled operation emitted progress") }
            )
            XCTFail("pre-cancelled operation must fail")
        } catch { XCTAssertTrue(error is CancellationError) }
    }

    func testEncryptedUploadV2UsesOneShotNativeMaterialAndSafeBridgeValues() async throws {
        let recordingUUID = "00112233-4455-6677-8899-aabbccddeeff"
        let uploadSessionID = UUID(uuidString: "10213243-5465-7687-98a9-bacbdcedfe0f")!
        let sinkID = "20314253-6475-8697-a8b9-cadbecfd0e1f"
        let recording = EncryptedUploadV2Recording(
            uuid: recordingUUID,
            generation: 4,
            ciphertextLength: 4_096,
            ciphertextSHA256: Data(repeating: 0x5a, count: 32)
        )
        let context = EncryptedUploadV2ProviderContext(
            recording: recording,
            capability: .init(
                rawValue: Data([
                    0x01, 0x02, 0x18, 0x00, 0x7f, 0x00, 0x00, 0x00,
                    0x00, 0x04, 0x00, 0x04, 0x00, 0x10, 0x00, 0x08,
                    0x00, 0x01, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00,
                ]),
                sha256: Data(repeating: 0x6b, count: 32),
                capabilities: .init(
                    flags: 0x7f,
                    maximumSignedBlobBytes: 1_024,
                    maximumManifestBytes: 1_024,
                    maximumDataPayloadBytes: 4_096,
                    maximumWindowPackets: 8,
                    durableCheckpointIntervalBlocks: 256,
                    maximumMissingSequences: 16
                )
            ),
            checkpoint: .init(
                uploadSessionID: uploadSessionID,
                ownerRevision: 2,
                revision: 3,
                nextCiphertextOffset: 2_048,
                prefixSHA256: Data(repeating: 0x7c, count: 32),
                highestContiguousSequence: 7,
                transportSessionID: 72_623_859_790_382_856,
                sinkID: sinkID,
                windowPackets: 8,
                dataPayloadBytes: 512
            )
        )
        let material = EncryptedUploadV2Material(
            materialID: "native-material-1",
            recordingID: recordingUUID,
            uploadSessionID: uploadSessionID,
            ownerRevision: 2,
            policy: .v2Required,
            authorization: Data(repeating: 0xa5, count: 32),
            stagingRequest: { _ in URLRequest(url: URL(string: "https://native.invalid/stage")!) },
            submitManifest: { _, _ in },
            finalize: { _ in },
            completionReceipt: { _ in Data(repeating: 0x3c, count: 16) }
        )
        let registrationID = BotaDeviceSDKEncryptedUploadV2Materials.register(material)
        let client = TestAppleRecordingClient(
            recording: DeviceRecording(
                uuid: "legacy-recording",
                startedAt: .distantPast,
                durationMs: 0,
                fileSizeBytes: 0,
                codec: .known(.opus16k),
                isEncrypted: false
            ),
            encryptedUploadV2Context: context
        )
        let recordings = BotaDeviceSDKAppleRecordings(client: client)
        let requestCapture = DictionaryCapture()
        let progressCapture = DictionaryListCapture()

        try await recordings.syncEncryptedRecordingV2(
            connectedDevice(),
            recording: recording,
            operationID: "operation-1",
            onProfileRequest: { request in
                requestCapture.store(request)
                let requestID = request["requestId"] as! String
                Task {
                    try await recordings.resolveEncryptedUploadV2Profile(
                        requestID: requestID,
                        profile: "encrypted_upload_v2",
                        uploadSessionID: uploadSessionID.uuidString.lowercased(),
                        ownerRevision: 2,
                        securityPolicy: "v2_required",
                        materialRegistrationID: registrationID
                    )
                }
            },
            onProgress: { progressCapture.append($0) }
        )

        let request = try XCTUnwrap(requestCapture.snapshot())
        XCTAssertEqual(Set(request.keys), ["requestId", "operationId", "recording", "capability", "checkpoint"])
        XCTAssertEqual(Set((request["recording"] as! [String: Any]).keys), [
            "uuid", "generation", "ciphertextLength", "ciphertextSha256",
            "startedAtMs", "durationMs", "plaintextLength", "storageFormat",
        ])
        let capability = request["capability"] as! [String: Any]
        XCTAssertEqual(Set(capability.keys), [
            "encodingVersion", "transferProfileVersion", "rawValueHex", "sha256Hex", "flags",
            "maximumSignedBlobBytes", "maximumManifestBytes", "maximumDataPayloadBytes",
            "maximumWindowPackets", "durableCheckpointIntervalBlocks", "maximumMissingSequences",
        ])
        XCTAssertEqual(capability["encodingVersion"] as? Int, 1)
        XCTAssertEqual(capability["transferProfileVersion"] as? Int, 2)
        XCTAssertEqual(Set((request["checkpoint"] as! [String: Any]).keys), [
            "version", "uploadSessionId", "ownerRevision", "revision", "nextCiphertextOffset",
            "prefixSha256", "highestContiguousSequence", "transportSessionId", "sinkRegistrationId",
            "windowPackets", "dataPayloadBytes",
        ])
        let selectedMaterialID = await client.selectedEncryptedMaterialID()
        XCTAssertEqual(selectedMaterialID, "native-material-1")
        XCTAssertEqual(
            progressCapture.snapshot().compactMap { $0["phase"] as? String },
            ["profile_requested", "transferring", "completed"]
        )
        XCTAssertNil(BotaDeviceSDKEncryptedUploadV2Materials.remove(registrationID))
    }

    func testEncryptedUploadV2MapsStableNativeFailureProgress() async {
        let failure = BotaSDKError(
            code: .protocolRejected,
            operation: .transferRecording,
            retryable: true,
            protocolStatus: 0x22,
            detail: "device rejected the selected policy"
        )
        let client = TestAppleRecordingClient(
            recording: DeviceRecording(
                uuid: "legacy-recording",
                startedAt: .distantPast,
                durationMs: 0,
                fileSizeBytes: 0,
                codec: .known(.opus16k),
                isEncrypted: false
            ),
            encryptedUploadV2Error: failure
        )
        let recordings = BotaDeviceSDKAppleRecordings(client: client)
        let progress = DictionaryListCapture()

        do {
            try await recordings.syncEncryptedRecordingV2(
                connectedDevice(),
                recording: .init(
                    uuid: "00112233-4455-6677-8899-aabbccddeeff",
                    generation: 4,
                    ciphertextLength: 4_096,
                    ciphertextSHA256: Data(repeating: 0x5a, count: 32)
                ),
                operationID: "operation-1",
                onProfileRequest: { _ in },
                onProgress: { progress.append($0) }
            )
            XCTFail("expected encrypted upload v2 to fail")
        } catch {
            XCTAssertEqual(error as? BotaSDKError, failure)
        }

        let event = progress.snapshot().last
        XCTAssertEqual(event?["phase"] as? String, "failed")
        XCTAssertEqual(event?["errorCode"] as? String, "protocol_rejected")
        XCTAssertEqual(event?["retryable"] as? Bool, true)
        XCTAssertEqual(event?["protocolStatus"] as? UInt16, 0x22)
    }

    func testRecordingListAndSyncKeepTransferBytesInNativeFile() async throws {
        let connected = ConnectedDevice(
            id: "selected",
            serialNumber: "EVFXXW67KP",
            deviceType: .botaPin,
            firmwareVersion: "1.0.11",
            isProvisioned: true,
            connectionState: .connected,
            mtu: 247
        )
        let recording = DeviceRecording(
            uuid: "recording-1",
            startedAt: Date(timeIntervalSince1970: 1_788_200_000),
            durationMs: 12_000,
            fileSizeBytes: 48_000,
            codec: .known(.opus16k),
            isEncrypted: true
        )
        let client = TestAppleRecordingClient(recording: recording)
        let recordings = BotaDeviceSDKAppleRecordings(client: client, fileSize: { _ in 48_036 })
        let progress = RecordingProgressCapture()

        let listed = try await recordings.listRecordings(connected)
        XCTAssertEqual(listed, [recording])
        let result = try await recordings.syncRecording(
            connected,
            recording: recording,
            sinkID: "sink-1"
        ) { value in
            progress.append(value)
        }

        XCTAssertEqual(result, .init(
            localPath: "/tmp/bota-recordings/recording-1.ogg",
            isE2EEncrypted: true,
            contentSHA256Hex: String(repeating: "5a", count: 32),
            fileSizeBytes: 48_036
        ))
        let progressSnapshot = progress.snapshot()
        XCTAssertEqual(
            progressSnapshot,
            [.init(completedBytes: 24_000, totalBytes: 48_000)]
        )
        let sinkIDs = await client.observedSinkIDs()
        XCTAssertEqual(sinkIDs, ["sink-1"])
        await recordings.cancelAll()
        let cancelled = await client.wasCancelled()
        XCTAssertTrue(cancelled)
    }

    func testUploadOwnershipReturnsNativeFallbackDecisionAndProgress() async throws {
        let connected = ConnectedDevice(
            id: "selected",
            serialNumber: "EVFXXW67KP",
            deviceType: .botaPin,
            firmwareVersion: "1.0.11",
            isProvisioned: true,
            connectionState: .connected,
            mtu: 247
        )
        let client = TestAppleRecordingClient(recording: DeviceRecording(
            uuid: "recording-1",
            startedAt: Date(timeIntervalSince1970: 1_788_200_000),
            durationMs: 12_000,
            fileSizeBytes: 48_000,
            codec: .known(.opus16k),
            isEncrypted: true
        ))
        let recordings = BotaDeviceSDKAppleRecordings(client: client)
        let progress = RecordingProgressCapture()

        let result = try await recordings.observeUploadOwnership(
            connected,
            recordingUUID: "recording-1",
            uploadID: "upload-1",
            destinationID: "destination-1"
        ) { value in
            progress.append(value)
        }

        XCTAssertEqual(
            result,
            .bluetoothFallback(
                recordingUUID: "recording-1",
                uploadID: "upload-1",
                destinationID: "destination-1"
            )
        )
        let progressSnapshot = progress.snapshot()
        XCTAssertEqual(
            progressSnapshot,
            [.init(completedBytes: 32_000, totalBytes: 48_000)]
        )
    }

    func testStreamingResolvesOneShotRequestsAndMapsProgress() async throws {
        let client = TestAppleRecordingClient(recording: DeviceRecording(
            uuid: "recording-1",
            startedAt: Date(timeIntervalSince1970: 1_788_200_000),
            durationMs: 12_000,
            fileSizeBytes: 48_000,
            codec: .known(.opus16k),
            isEncrypted: false
        ))
        let recordings = BotaDeviceSDKAppleRecordings(client: client)
        let capture = StreamingCapture()
        let progressCapture = StreamingProgressCapture()

        let total = try await recordings.streamRecording(
            ConnectedDevice(
                id: "selected",
                serialNumber: "EVFXXW67KP",
                deviceType: .botaPin,
                firmwareVersion: "1.0.11",
                isProvisioned: true,
                connectionState: .connected,
                mtu: 247
            ),
            recordingUUID: "recording-1",
            sessionID: UUID().uuidString,
            chunkSizeBytes: 64 * 1_024,
            flushIntervalMilliseconds: 1_000,
            onProgress: { value in
                let state = value["state"] as! String
                progressCapture.append(state)
            },
            onDestinationRequest: { value in
                let requestID = value["requestId"] as! String
                let sequence = value["sequence"] as! UInt32
                let encrypted = value["encrypted"] as! Bool
                Task {
                    await capture.destination(sequence: sequence, encrypted: encrypted)
                    await recordings.resolveStreamingDestination(
                        requestID: requestID,
                        url: "https://example.test/chunk/1",
                        method: "PUT",
                        contentType: "audio/ogg",
                        bearerToken: nil
                    )
                }
            },
            onFinalizeRequest: { value in
                let requestID = value["requestId"] as! String
                let totalChunks = value["totalChunks"] as! UInt32
                Task {
                    await capture.finalize(totalChunks: totalChunks)
                    await recordings.resolveStreamingFinalize(
                        requestID: requestID
                    )
                }
            }
        )

        XCTAssertEqual(total, 96)
        let destinationSequence = await capture.destinationSequence
        let destinationEncrypted = await capture.destinationEncrypted
        let finalizedChunks = await capture.finalizedChunks
        let states = progressCapture.snapshot()
        XCTAssertEqual(destinationSequence, 1)
        XCTAssertEqual(destinationEncrypted, false)
        XCTAssertEqual(finalizedChunks, 2)
        XCTAssertEqual(states, ["streaming", "paused", "streaming", "completing"])
    }
}

private func connectedDevice() -> ConnectedDevice {
    ConnectedDevice(
        id: "selected",
        serialNumber: "EVFXXW67KP",
        deviceType: .botaPin,
        firmwareVersion: "1.0.11",
        isProvisioned: true,
        connectionState: .connected,
        mtu: 247
    )
}

private final class DictionaryCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var value: [String: Any]?

    func store(_ value: [String: Any]) {
        lock.withLock { self.value = value }
    }

    func snapshot() -> [String: Any]? {
        lock.withLock { value }
    }
}

private final class DictionaryListCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [[String: Any]] = []

    func append(_ value: [String: Any]) {
        lock.withLock { values.append(value) }
    }

    func snapshot() -> [[String: Any]] {
        lock.withLock { values }
    }
}

private final class RecordingProgressCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [RecordingTransferProgress] = []

    func append(_ value: RecordingTransferProgress) {
        lock.lock()
        defer { lock.unlock() }
        values.append(value)
    }

    func snapshot() -> [RecordingTransferProgress] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }
}

private actor StreamingCapture {
    private(set) var destinationSequence: UInt32?
    private(set) var destinationEncrypted: Bool?
    private(set) var finalizedChunks: UInt32?
    func destination(sequence: UInt32, encrypted: Bool) {
        destinationSequence = sequence
        destinationEncrypted = encrypted
    }
    func finalize(totalChunks: UInt32) {
        finalizedChunks = totalChunks
    }
}

private final class StreamingProgressCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []

    func append(_ value: String) {
        lock.withLock { values.append(value) }
    }

    func snapshot() -> [String] {
        lock.withLock { values }
    }
}

private actor TestAppleRecordingClient: BotaDeviceSDKAppleRecordingClient {
    private let recording: DeviceRecording
    private let encryptedUploadV2Context: EncryptedUploadV2ProviderContext?
    private let encryptedUploadV2Error: BotaSDKError?
    private var cancelled = false
    private var sinkIDs: [String] = []
    private var confirmedRecordingUUIDs: [String] = []
    private var encryptedMaterialID: String?

    init(
        recording: DeviceRecording,
        encryptedUploadV2Context: EncryptedUploadV2ProviderContext? = nil,
        encryptedUploadV2Error: BotaSDKError? = nil
    ) {
        self.recording = recording
        self.encryptedUploadV2Context = encryptedUploadV2Context
        self.encryptedUploadV2Error = encryptedUploadV2Error
    }

    func listRecordings(_ device: ConnectedDevice) async throws -> [DeviceRecording] {
        [recording]
    }

    func listPendingRecordings(_ device: ConnectedDevice) async throws -> [PendingRecording] {
        [.legacy(recording)]
    }

    func cancelEncryptedUploadV2Operation(_ operationID: UUID) async throws { cancelled = true }

    func syncRecording(
        _ device: ConnectedDevice,
        recording: DeviceRecording,
        sinkID: String
    ) async throws -> AsyncThrowingStream<RecordingSyncEvent, Error> {
        sinkIDs.append(sinkID)
        let pair = AsyncThrowingStream<RecordingSyncEvent, Error>.makeStream()
        pair.continuation.yield(.progress(.init(completedBytes: 24_000, totalBytes: 48_000)))
        pair.continuation.yield(.completed(URL(fileURLWithPath: "/tmp/bota-recordings/recording-1.ogg")))
        pair.continuation.finish()
        return pair.stream
    }

    func transferMetadata(sinkID _: String) async -> RecordingTransferMetadata? {
        RecordingTransferMetadata(
            isE2EEncrypted: true,
            contentSHA256Hex: String(repeating: "5a", count: 32)
        )
    }

    func syncEncryptedRecordingV2(
        _ device: ConnectedDevice,
        recording: EncryptedUploadV2Recording,
        operationID: UUID,
        provider: @escaping EncryptedUploadV2ProfileProvider
    ) async throws {
        if let encryptedUploadV2Error { throw encryptedUploadV2Error }
        guard let encryptedUploadV2Context else {
            throw NSError(domain: "TestAppleRecordingClient", code: 1)
        }
        let material = try await provider(encryptedUploadV2Context)
        encryptedMaterialID = material.materialID
    }

    func confirmRecording(_ device: ConnectedDevice, recordingUUID: String) async throws {
        confirmedRecordingUUIDs.append(recordingUUID)
    }

    func observeUploadOwnership(
        _ device: ConnectedDevice,
        recordingUUID: String,
        uploadID: String,
        destinationID: String
    ) async throws -> AsyncThrowingStream<UploadOwnershipEvent, Error> {
        let pair = AsyncThrowingStream<UploadOwnershipEvent, Error>.makeStream()
        pair.continuation.yield(.progress(.init(completedBytes: 32_000, totalBytes: 48_000)))
        pair.continuation.yield(.result(.bluetoothFallback(
            recordingUUID: recordingUUID,
            uploadID: uploadID,
            destinationID: destinationID
        )))
        pair.continuation.finish()
        return pair.stream
    }

    func streamRecording(
        _ device: ConnectedDevice,
        recordingUUID: String,
        sinkID: String,
        chunkSizeBytes: Int,
        flushIntervalMilliseconds: UInt64,
        destinationProvider: @escaping StreamingChunkDestinationProvider,
        finalize: @escaping StreamingFinalizeHandler
    ) async throws -> AsyncThrowingStream<StreamingRecordingEvent, Error> {
        sinkIDs.append(sinkID)
        let pair = AsyncThrowingStream<StreamingRecordingEvent, Error>.makeStream()
        Task {
            do {
                _ = try await destinationProvider(.init(sequence: 1, isEncrypted: false))
                try await finalize(.init(
                    totalChunks: 2,
                    durationMilliseconds: 500,
                    fileSizeBytes: 96,
                    isEncrypted: false
                ))
                pair.continuation.yield(.paused(completedBytes: 32))
                pair.continuation.yield(.resumed)
                pair.continuation.yield(.completed(
                    totalBytes: 96,
                    uploadedChunks: 2,
                    isEncrypted: false
                ))
                pair.continuation.finish()
            } catch {
                pair.continuation.finish(throwing: error)
            }
        }
        return pair.stream
    }

    func cancelCurrentOperation() async throws {
        cancelled = true
    }

    func wasCancelled() -> Bool {
        cancelled
    }

    func observedSinkIDs() -> [String] {
        sinkIDs
    }

    func selectedEncryptedMaterialID() -> String? {
        encryptedMaterialID
    }
}
