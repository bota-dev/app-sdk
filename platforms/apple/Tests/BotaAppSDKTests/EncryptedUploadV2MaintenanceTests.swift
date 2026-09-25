import Foundation
import CryptoKit
import XCTest
@testable import BotaAppSDK

final class EncryptedUploadV2MaintenanceTests: XCTestCase {
    func testFrameBoundsBelowMandatoryStartAckRejectBeforeProviderAndStart() async throws {
        for frameBytes in 128..<140 {
            let runner = TransferWorkflowRunner { _ in [transferCompleted(operation: 4)] }
            let recorder = TransferFacadeRecorder()
            let calls = CatalogCalls()
            let manager = RecordingManager()
            await manager.attach(await transferRuntime(runner: runner, recorder: recorder,
                encryptedUploadV2Capabilities: { _ in Self.capability },
                encryptedUploadV2MaximumWriteLength: { _ in frameBytes },
                registerEncryptedUploadV2Material: { _, _ in await calls.append("register") }
            ))
            do {
                try await manager.syncEncryptedRecordingV2(transferDevice(), recording: Self.recording) { _ in
                    await calls.append("provider")
                    return Self.material()
                }
                XCTFail("Frame bound \(frameBytes) cannot carry the mandatory START_ACK")
            } catch let error as BotaSDKError {
                XCTAssertEqual(error.code, .unsupportedCapability)
            }
            let actualCalls = await calls.values
            let commands = await runner.commands
            let writes = await recorder.writes
            XCTAssertTrue(actualCalls.isEmpty, "Frame bound \(frameBytes) must fail before provider")
            XCTAssertTrue(commands.isEmpty, "Frame bound \(frameBytes) must fail before START")
            XCTAssertTrue(writes.isEmpty)
        }
    }

    func testMinimumMandatoryStartAckFrameBoundAllowsProviderAndStart() async throws {
        let runner = TransferWorkflowRunner { _ in [transferCompleted(operation: 4)] }
        let calls = CatalogCalls()
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(runner: runner, recorder: TransferFacadeRecorder(),
            encryptedUploadV2Capabilities: { _ in Self.capability },
            encryptedUploadV2MaximumWriteLength: { _ in 140 }
        ))
        try await manager.syncEncryptedRecordingV2(transferDevice(), recording: Self.recording) { _ in
            await calls.append("provider")
            return Self.material()
        }
        let actualCalls = await calls.values
        let commands = await runner.commands
        XCTAssertEqual(actualCalls, ["provider"])
        XCTAssertEqual(commands.count, 1)
    }

    func testTaskCancelledBeforeNativeEntryDoesNotReadBleOrPrepareMaterial() async throws {
        let runner = TransferWorkflowRunner { _ in [] }
        let manager = RecordingManager()
        let operationID = UUID()
        await manager.attach(await transferRuntime(runner: runner, recorder: TransferFacadeRecorder(),
            encryptedUploadV2Capabilities: { _ in
                XCTFail("A pre-cancelled task must not read capabilities")
                return Self.capability
            }, registerEncryptedUploadV2Material: { _, _ in
                XCTFail("A pre-cancelled task must not register material")
            }
        ))
        let task = Task.detached { @Sendable in
            withUnsafeCurrentTask { $0?.cancel() }
            try await manager.syncEncryptedRecordingV2(transferDevice(), recording: Self.recording,
                operationID: operationID) { _ in
                    XCTFail("A pre-cancelled task must not prepare material")
                    return Self.material()
                }
        }
        do { try await task.value; XCTFail("A pre-cancelled task must fail") } catch {}
        let commands = await runner.commands
        XCTAssertTrue(commands.isEmpty)
    }

    func testNativeAuthNonceIsScopedToExactOperationAndConnection() async throws {
        let runner = SuspendedTransferWorkflowRunner()
        let manager = RecordingManager()
        let connection = DeviceConnectionRegistry()
        await connection.set(transferDevice())
        let capture = ContextCapture()
        let reads = CatalogCalls()
        let operationID = UUID()
        await manager.attach(DeviceRuntime(engine: runner, capabilities: .all, connection: connection,
            disconnect: { _ in }, directRead: { _, service, characteristic in
                XCTAssertEqual(service, BotaBluetoothUUIDs.authService)
                XCTAssertEqual(characteristic, BotaBluetoothUUIDs.authNonce)
                await reads.append("nonce")
                return Data(repeating: 9, count: 16)
            }, readEncryptedUploadV2Capabilities: { _ in Self.capability },
            validateEncryptedUploadV2Selection: { _, _, _, _ in },
            encryptedUploadV2MaximumWriteLength: { _ in 185 }
        ))
        let started = expectation(description: "v2 provider nonce read")
        let recording = Self.recording
        let selectedMaterial = Self.material()
        let work = Task.detached { @Sendable in
            try await manager.syncEncryptedRecordingV2(transferDevice(), recording: recording, operationID: operationID) { context in
                await capture.store(context)
                let nonce = try await context.readAuthNonce()
                XCTAssertEqual(nonce, Data(repeating: 9, count: 16))
                started.fulfill()
                return selectedMaterial
            }
        }
        await fulfillment(of: [started], timeout: 5)
        let engineStarted = expectation(description: "engine started")
        Task { await runner.waitUntilStarted(); engineStarted.fulfill() }
        await fulfillment(of: [engineStarted], timeout: 5)
        try await manager.cancelEncryptedUploadV2Operation(UUID())
        let before = await runner.cancellations
        XCTAssertTrue(before.isEmpty)
        let captured = await capture.value()
        let context = try XCTUnwrap(captured)
        await connection.set(transferDevice())
        do { _ = try await context.readAuthNonce(); XCTFail("Reconnect must invalidate captured nonce access") } catch {}
        try await manager.cancelEncryptedUploadV2Operation(operationID)
        _ = try? await work.value
        do { _ = try await context.readAuthNonce(); XCTFail("Terminal owner must not read nonce") } catch {}
        let actualReads = await reads.values
        XCTAssertEqual(actualReads, ["nonce"])
        let cancellations = await runner.cancellations
        XCTAssertEqual(cancellations, [operationID])
    }

    func testPendingCatalogDoesNotDowngradeGattFailureOrMalformedCapability() async throws {
        for failure in [BotaSDKErrorCode.integrityFailed, .notConnected] {
            let manager = RecordingManager()
            let connection = DeviceConnectionRegistry()
            await connection.set(transferDevice())
            await manager.attach(DeviceRuntime(engine: TransferWorkflowRunner { _ in [] }, capabilities: .all,
                connection: connection, disconnect: { _ in },
                directWrite: { _, _, _, _ in XCTFail("No legacy fallback after capability error") },
                readEncryptedUploadV2Capabilities: { _ in
                    throw BotaSDKError(code: failure, operation: .decode, retryable: false, detail: "fixture")
                }
            ))
            do { _ = try await manager.listPendingRecordings(transferDevice()); XCTFail("Must reject") } catch {}
        }
    }

    private static func material() -> EncryptedUploadV2Material {
        .init(materialID: "native", recordingID: "rec_test", uploadSessionID: UUID(), ownerRevision: 1,
              policy: .v2Required, authorization: Data(repeating: 1, count: 408),
              stagingRequest: { _ in throw TestError.unexpectedUpload }, submitManifest: { _, _ in },
              finalize: { _ in }, completionReceipt: { _ in Data() },
              uploadContext: { _ in .init(challenge: Data(), exchangeProof: { _ in Data() }) })
    }
    func testCatalogValidatesCountDigestAndConvertsMetadata() throws {
        let mapper = try CoreModelMapper()
        let session: UInt64 = 0x112233445566
        var entry = try Self.vector("ble-recording-entry")
        entry.replaceSubrange(36..<44, with: Data([1, 0, 0, 0, 0, 0, 0, 0]))
        var end = try Self.vector("ble-recording-list-end")
        end.replaceSubrange(20..<52, with: Data(SHA256.hash(data: entry.dropFirst(12))))
        XCTAssertNil(try mapper.decodeEncryptedUploadV2Catalog(Data(), transportSessionID: session))
        XCTAssertNil(try mapper.decodeEncryptedUploadV2Catalog(entry, transportSessionID: session))
        let values = try XCTUnwrap(mapper.decodeEncryptedUploadV2Catalog(end, transportSessionID: session))
        XCTAssertEqual(values.count, 1)
        XCTAssertEqual(values[0].startedAtMs, 1000)
        XCTAssertEqual(values[0].durationMs, 37000)
        XCTAssertEqual(values[0].plaintextLength, 38)
        XCTAssertEqual(values[0].storageFormat, 3)
        XCTAssertEqual(values[0].generation, 9)
        _ = try mapper.decodeEncryptedUploadV2Catalog(Data(), transportSessionID: session)
        _ = try mapper.decodeEncryptedUploadV2Catalog(entry, transportSessionID: session)
        end[20] ^= 1
        XCTAssertThrowsError(try mapper.decodeEncryptedUploadV2Catalog(end, transportSessionID: session))
    }

    func testListCommandUsesSharedTransferEncoder() throws {
        XCTAssertEqual(try CoreModelMapper().createEncryptedUploadV2List(transportSessionID: 1),
                       Data([0x25, 2, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
    }

    func testCatalogRejectsTimestampOverflowWithoutWrapping() throws {
        let mapper = try CoreModelMapper()
        _ = try mapper.decodeEncryptedUploadV2Catalog(Data(), transportSessionID: 0x112233445566)
        _ = try mapper.decodeEncryptedUploadV2Catalog(Self.vector("ble-recording-entry"), transportSessionID: 0x112233445566)
        XCTAssertThrowsError(try mapper.decodeEncryptedUploadV2Catalog(Self.vector("ble-recording-list-end"), transportSessionID: 0x112233445566))
    }

    func testSignedReplacementRequiresRecoveryAndRetainedCiphertextIdentity() throws {
        let mapper = try CoreModelMapper()
        var auth = try Self.vector("authorization-development")
        auth[30] |= 8
        let hash = Data(auth[312..<344])
        let recording = EncryptedUploadV2Recording(uuid: Self.recording.uuid, generation: 9, ciphertextLength: 330, ciphertextSHA256: hash)
        let material = EncryptedUploadV2Material(materialID: "replacement", recordingID: "rec_test",
            uploadSessionID: UUID(uuidString: "10111213-1415-1617-1819-1a1b1c1d1e1f")!, ownerRevision: 3,
            policy: .v2Required, authorization: auth,
            stagingRequest: { _ in throw TestError.unexpectedUpload }, submitManifest: { _, _ in },
            finalize: { _ in }, completionReceipt: { _ in Data() })
        let old = EncryptedUploadV2Checkpoint(uploadSessionID: UUID(), ownerRevision: 2, revision: 1,
            nextCiphertextOffset: 100, prefixSHA256: Data(repeating: 1, count: 32), highestContiguousSequence: 1,
            transportSessionID: 1, sinkID: UUID().uuidString, windowPackets: 1, dataPayloadBytes: 128,
            ciphertextLength: 330, ciphertextSHA256: hash)
        var capability = try Self.vector("capability")
        capability[4] = 0x7f; capability[5] = 3
        let snapshot = EncryptedUploadV2CapabilitySnapshot(rawValue: capability, sha256: Data(), capabilities: .init(value: try mapper.decodeEncryptedUploadV2Capabilities(capability)))
        XCTAssertNoThrow(try mapper.validateEncryptedUploadV2Selection(material: material, recording: recording, capability: snapshot, checkpoint: old))
        let historical = EncryptedUploadV2Checkpoint(uploadSessionID: old.uploadSessionID, ownerRevision: 2, revision: 1,
            nextCiphertextOffset: 100, prefixSHA256: old.prefixSHA256, highestContiguousSequence: 1,
            transportSessionID: 1, sinkID: old.sinkID, windowPackets: 1, dataPayloadBytes: 128)
        XCTAssertThrowsError(try mapper.validateEncryptedUploadV2Selection(material: material, recording: recording, capability: snapshot, checkpoint: historical))
        capability[5] = 1
        let noRecovery = EncryptedUploadV2CapabilitySnapshot(rawValue: capability, sha256: Data(), capabilities: snapshot.capabilities)
        XCTAssertThrowsError(try mapper.validateEncryptedUploadV2Selection(material: material, recording: recording, capability: noRecovery, checkpoint: old))
    }

    func testSharedContextCodecProducesExactBeginAndRejectsMalformedSnapshot() throws {
        let mapper = try CoreModelMapper()
        XCTAssertEqual(try mapper.createEncryptedUploadV2ContextBegin(attemptID: 0x12345678),
                       Data([0x65, 2, 0, 0, 0x78, 0x56, 0x34, 0x12]))
        let bytes = Data([0x66, 2, 1, 0, 1, 0, 0, 0, 0, 0, 16, 0]) + Data(repeating: 7, count: 16)
        let snapshot = try mapper.decodeEncryptedUploadV2ContextSnapshot(bytes)
        XCTAssertEqual(snapshot.attemptID, 1)
        XCTAssertEqual(snapshot.payload, Data(repeating: 7, count: 16))
        XCTAssertThrowsError(try mapper.decodeEncryptedUploadV2ContextSnapshot(bytes + Data([0])))
    }

    func testMissingContextRejectsBeforeCoreOrMaterialRegistration() async throws {
        let runner = TransferWorkflowRunner { _ in [transferCompleted(operation: 4)] }
        let manager = RecordingManager()
        let material = EncryptedUploadV2Material(
            materialID: "missing-context", recordingID: "rec_test", uploadSessionID: UUID(),
            ownerRevision: 1, policy: .v2Required, authorization: Data(repeating: 1, count: 408),
            stagingRequest: { _ in throw TestError.unexpectedUpload },
            submitManifest: { _, _ in }, finalize: { _ in }, completionReceipt: { _ in Data() }
        )
        await manager.attach(await transferRuntime(runner: runner, recorder: TransferFacadeRecorder(),
            encryptedUploadV2Capabilities: { _ in Self.capability },
            registerEncryptedUploadV2Material: { _, _ in XCTFail("Missing context must fail before registration") }
        ))
        do {
            try await manager.syncEncryptedRecordingV2(transferDevice(), recording: Self.recording) { _ in material }
            XCTFail("Missing context must fail")
        } catch {}
        let commands = await runner.commands
        XCTAssertTrue(commands.isEmpty)
    }

    func testPendingCatalogReadsLegacyFirstAndSuppressesAlias() async throws {
        let calls = CatalogCalls()
        let manager = RecordingManager()
        let connection = DeviceConnectionRegistry()
        await connection.set(transferDevice())
        await manager.attach(DeviceRuntime(
            engine: TransferWorkflowRunner { _ in [] }, capabilities: .all, connection: connection,
            disconnect: { _ in },
            directWrite: { _, _, _, _ in await calls.append("legacy") },
            directSubscribe: { _, _, _ in AsyncThrowingStream { $0.yield(Data()); $0.finish() } },
            readEncryptedUploadV2Capabilities: { _ in Self.capability },
            listEncryptedUploadV2Recordings: { _ in await calls.append("v2"); return [Self.recording] },
            parseRecordingList: { _ in [Self.legacy("00112233"), Self.legacy("11223344")] },
            createTransferCommand: { _ in Data() }
        ))
        let values = try await manager.listPendingRecordings(transferDevice())
        XCTAssertEqual(values, [.encryptedV2(Self.recording), .legacy(Self.legacy("11223344"))])
        let sequence = await calls.values
        XCTAssertEqual(sequence, ["legacy", "v2"])
    }

    static let recording = EncryptedUploadV2Recording(
        uuid: "00112233-4455-6677-8899-aabbccddeeff", generation: 1,
        ciphertextLength: 272, ciphertextSHA256: Data(repeating: 1, count: 32)
    )
    static let capability = EncryptedUploadV2CapabilitySnapshot(rawValue: Data(), sha256: Data(), capabilities: .init(
        flags: 0x17f, maximumSignedBlobBytes: 408, maximumManifestBytes: 580,
        maximumDataPayloadBytes: 160, maximumWindowPackets: 4, durableCheckpointIntervalBlocks: 1,
        maximumMissingSequences: 4
    ))
    static func legacy(_ prefix: String) -> DeviceRecording {
        .init(uuid: prefix + "-0000-0000-0000-000000000000", startedAt: Date(timeIntervalSince1970: 0),
              durationMs: 1, fileSizeBytes: 1, codec: .known(.opus16k), isEncrypted: false)
    }
    func testOldRecordingInitializerPreservesDefaults() {
        let value = EncryptedUploadV2Recording(
            uuid: UUID().uuidString, generation: 1,
            ciphertextLength: 272, ciphertextSHA256: Data(repeating: 1, count: 32)
        )
        XCTAssertEqual(value.startedAtMs, 0)
        XCTAssertEqual(value.durationMs, 0)
        XCTAssertEqual(value.plaintextLength, 0)
        XCTAssertEqual(value.storageFormat, 3)
    }

    func testNativeMaterialForwardsContextAndUploadDecision() async throws {
        let material = EncryptedUploadV2Material(
            materialID: "native", recordingID: "rec_test", uploadSessionID: UUID(),
            ownerRevision: 1, policy: .v2Required, authorization: Data(repeating: 1, count: 408),
            stagingRequest: { _ in throw TestError.unexpectedUpload },
            submitManifest: { _, _ in }, finalize: { _ in }, completionReceipt: { _ in Data() },
            uploadContext: { nonce in
                XCTAssertEqual(nonce, Data(repeating: 2, count: 16))
                return EncryptedUploadV2ContextExchange(challenge: Data([3]), exchangeProof: { proof in
                    XCTAssertEqual(proof, Data([4]))
                    return Data([5])
                })
            },
            shouldUploadCiphertext: { _ in false }
        )
        let exchange = try await XCTUnwrap(material.uploadContext)(Data(repeating: 2, count: 16))
        XCTAssertEqual(exchange.challenge, Data([3]))
        let result = try await exchange.exchangeProof(Data([4]))
        XCTAssertEqual(result, Data([5]))
        let registry = EncryptedUploadV2MaterialRegistry()
        try await registry.register(id: "native", provider: material.provider)
        let prepared = try await registry.preparedMaterial(id: "native")
        let upload = try await registry.shouldUploadCiphertext(id: "native", lease: prepared.lease, evidence: .init(
            ciphertextLength: 272, ciphertextSHA256: Data(repeating: 1, count: 32),
            manifestLength: 580, manifestSHA256: Data(repeating: 2, count: 32), blockCount: 1
        ))
        XCTAssertFalse(upload)
    }

    private enum TestError: Error { case unexpectedUpload }

    private static func vector(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "encrypted-upload-v2", withExtension: "json", subdirectory: "EncryptedUploadV2Vectors"))
        let document = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let cases = try XCTUnwrap(document["cases"] as? [[String: Any]])
        let hex = try XCTUnwrap(cases.first { $0["name"] as? String == name }?["inputHex"] as? String)
        return Data(stride(from: 0, to: hex.count, by: 2).map { offset in
            let start = hex.index(hex.startIndex, offsetBy: offset)
            return UInt8(hex[start..<hex.index(start, offsetBy: 2)], radix: 16)!
        })
    }
}

private actor CatalogCalls {
    var values: [String] = []
    func append(_ value: String) { values.append(value) }
}

private actor ContextCapture {
    var context: EncryptedUploadV2ProviderContext?
    func store(_ value: EncryptedUploadV2ProviderContext) { context = value }
    func value() -> EncryptedUploadV2ProviderContext? { context }
}
