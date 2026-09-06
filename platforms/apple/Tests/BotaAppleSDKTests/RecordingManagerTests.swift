import BotaDeviceSDKC
import Foundation
import XCTest

@testable import BotaAppleSDK

final class RecordingManagerTests: XCTestCase {
    func testListSubscribesBeforeCommandAndUsesSharedEncryptedRecordingDecoder() async throws {
        let data = Self.hex("a1b2c3d401000000000000000000000000f153650c000400")
        let runner = TransferWorkflowRunner { _ in [] }
        let recorder = TransferFacadeRecorder()
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(
            runner: runner,
            recorder: recorder,
            notificationData: data
        ))

        let recordings = try await manager.listRecordings(transferDevice())

        XCTAssertEqual(recordings.count, 1)
        XCTAssertTrue(recordings[0].isEncrypted)
        let subscriptions = await recorder.subscriptions
        let writes = await recorder.writes
        XCTAssertEqual(subscriptions, [BotaBluetoothUUIDs.recordingList])
        XCTAssertEqual(writes.map(\.data), [Data([1])])
    }

    func testTransferMapsProgressAndCompletesWithNativeFile() async throws {
        let runner = TransferWorkflowRunner { _ in [
            transferNotification(
                UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_PROGRESS),
                operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_TRANSFER_RECORDING),
                fields: [
                    .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMPLETED_UNITS), value: 512),
                    .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TOTAL_UNITS), value: 1024),
                ]
            ),
            transferNotification(
                UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_COMPLETED),
                operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_TRANSFER_RECORDING),
                fields: [
                    .bool(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ENCRYPTED), value: true),
                    .bytes(id: 123, value: Data(repeating: 0x5a, count: 32)),
                ]
            ),
        ] }
        let recorder = TransferFacadeRecorder()
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(runner: runner, recorder: recorder))
        let recording = DeviceRecording(
            uuid: "00112233-4455-6677-8899-aabbccddeeff",
            startedAt: Date(timeIntervalSince1970: 0),
            durationMs: 1,
            fileSizeBytes: 1024,
            codec: .known(.opus16k),
            isEncrypted: true
        )

        let stream = try await manager.syncRecording(
            transferDevice(),
            recording: recording,
            sinkID: "sink-1",
            confirmOnCompletion: false
        )
        var values: [RecordingSyncEvent] = []
        for try await value in stream { values.append(value) }

        XCTAssertEqual(values.first, .progress(.init(completedBytes: 512, totalBytes: 1024)))
        guard case let .completed(fileURL) = values.last else { return XCTFail("expected file completion") }
        XCTAssertEqual(fileURL.pathExtension, "recording")
        let metadata = await manager.transferMetadata(sinkID: "sink-1")
        XCTAssertEqual(metadata, .init(
            isE2EEncrypted: true,
            contentSHA256Hex: String(repeating: "5a", count: 32)
        ))
        let consumedMetadata = await manager.transferMetadata(sinkID: "sink-1")
        XCTAssertNil(consumedMetadata)
        let commands = await runner.commands
        XCTAssertEqual(commands.first?.kind, UInt32(BOTA_DEVICE_SDK_V1_COMMAND_TRANSFER_RECORDING))
        XCTAssertTrue(commands.first?.fields.contains(.bool(id: 124, value: false)) == true)
    }

    func testConfirmRecordingWritesDeleteOnlyAfterTheCallerRequestsIt() async throws {
        let recorder = TransferFacadeRecorder()
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(
            runner: TransferWorkflowRunner { _ in [] },
            recorder: recorder
        ))

        try await manager.confirmRecording(
            transferDevice(),
            recordingUUID: "00112233-4455-6677-8899-aabbccddeeff"
        )

        let writes = await recorder.writes
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes.first?.characteristic, BotaBluetoothUUIDs.transferControl)
        XCTAssertEqual(writes.first?.data.first, 7)
    }

    func testUploadOwnershipYieldsFallbackOnlyFromCoreNotification() async throws {
        let runner = TransferWorkflowRunner { _ in [
            transferNotification(
                UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_BLE_FALLBACK_READY),
                operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_UPLOAD),
                fields: [
                    .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RECORDING_UUID), value: "00112233445566778899aabbccddeeff"),
                    .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_UPLOAD_ID), value: "upload-1"),
                    .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DESTINATION_ID), value: "destination-1"),
                ]
            ),
            transferCompleted(operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_UPLOAD)),
        ] }
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(runner: runner, recorder: TransferFacadeRecorder()))

        let stream = try await manager.observeUploadOwnership(
            transferDevice(),
            recordingUUID: "00112233445566778899aabbccddeeff",
            uploadID: "upload-1",
            destinationID: "destination-1"
        )
        var values: [UploadOwnershipEvent] = []
        for try await value in stream { values.append(value) }

        XCTAssertEqual(values.last, .result(.bluetoothFallback(
            recordingUUID: "00112233445566778899aabbccddeeff",
            uploadID: "upload-1",
            destinationID: "destination-1"
        )))
    }

    func testStreamingRegistersNativeSinkAndMapsLifecycleNotifications() async throws {
        let runner = TransferWorkflowRunner { _ in [
            transferNotification(0x040d, operation: 8, fields: [.unsigned(id: 36, value: 512)]),
            transferNotification(0x040e, operation: 8),
            transferNotification(0x040f, operation: 8, fields: [
                .unsigned(id: 15, value: 1_024),
                .unsigned(id: 126, value: 2),
                .bool(id: 90, value: true),
            ]),
        ] }
        let recorder = TransferFacadeRecorder()
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(runner: runner, recorder: recorder))
        let sinkID = UUID().uuidString

        let stream = try await manager.streamRecording(
            transferDevice(),
            recordingUUID: "00112233445566778899aabbccddeeff",
            sinkID: sinkID,
            chunkSizeBytes: 512,
            flushIntervalMilliseconds: 1_000,
            destinationProvider: { _ in
                .init(url: URL(string: "https://example.test/chunk")!, method: .put, contentType: "audio/ogg")
            },
            finalize: { _ in }
        )
        var values: [StreamingRecordingEvent] = []
        for try await value in stream { values.append(value) }

        XCTAssertEqual(values, [
            .paused(completedBytes: 512),
            .resumed,
            .completed(totalBytes: 1_024, uploadedChunks: 2, isEncrypted: true),
        ])
        let registrations = await recorder.streamingRegistrations
        let unregistrations = await recorder.streamingUnregistrations
        let commands = await runner.commands
        XCTAssertEqual(registrations, [sinkID])
        XCTAssertEqual(unregistrations, [sinkID])
        XCTAssertEqual(commands.first?.kind, 0x010b)
    }

    func testEncryptedV2ReadsFreshSnapshotBeforeApplicationSelectionAndStartsOnlyV2() async throws {
        let capability = EncryptedUploadV2CapabilitySnapshot(
            rawValue: Data(repeating: 0xa1, count: 24),
            sha256: Data(repeating: 0xb2, count: 32),
            capabilities: .init(
                flags: 0x7f,
                maximumSignedBlobBytes: 408,
                maximumManifestBytes: 580,
                maximumDataPayloadBytes: 160,
                maximumWindowPackets: 4,
                durableCheckpointIntervalBlocks: 1,
                maximumMissingSequences: 4
            )
        )
        let runner = TransferWorkflowRunner { _ in [
            transferNotification(UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_COMPLETED), operation: 4),
        ] }
        let checkpoint = EncryptedUploadV2Checkpoint(
            uploadSessionID: UUID(uuidString: "10213243-5465-7687-98a9-bacbdcedfe0f")!,
            ownerRevision: 2,
            revision: 5,
            nextCiphertextOffset: 512,
            prefixSHA256: Data(repeating: 0x44, count: 32),
            highestContiguousSequence: 3,
            transportSessionID: 0x1020_3040_5060_7080,
            sinkID: "11223344-5566-7788-99aa-bbccddeeff00",
            windowPackets: 2,
            dataPayloadBytes: 100
        )
        let recorder = TransferFacadeRecorder()
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(
            runner: runner,
            recorder: recorder,
            encryptedUploadV2Capabilities: { _ in capability },
            encryptedUploadV2Checkpoint: { serialNumber, recordingUUID, generation in
                XCTAssertEqual(serialNumber, "EVFXXW67KP")
                XCTAssertEqual(recordingUUID, "00112233-4455-6677-8899-aabbccddeeff")
                XCTAssertEqual(generation, 3)
                return checkpoint
            }
        ))

        let recording = EncryptedUploadV2Recording(
            uuid: "00112233-4455-6677-8899-aabbccddeeff",
            generation: 3,
            ciphertextLength: 1024,
            ciphertextSHA256: Data(repeating: 0x5a, count: 32)
        )
        let selection = EncryptedUploadV2SelectionRecorder()
        try await manager.syncEncryptedRecordingV2(transferDevice(), recording: recording) { context in
            await selection.record(context)
            return .init(
                materialID: "material-id",
                recordingID: "rec_123",
                uploadSessionID: checkpoint.uploadSessionID,
                ownerRevision: checkpoint.ownerRevision,
                policy: .v2Required,
                authorization: Data(repeating: 0xc3, count: 408),
                stagingRequest: { _ in URLRequest(url: URL(string: "https://staging.example/upload")!) },
                submitManifest: { _, _ in },
                finalize: { _ in },
                completionReceipt: { _ in Data(repeating: 0xd4, count: 336) },
                cancel: {}
            )
        }

        let selectedContext = await selection.context
        XCTAssertEqual(selectedContext?.capability, capability)
        XCTAssertEqual(selectedContext?.checkpoint, checkpoint)
        let commands = await runner.commands
        XCTAssertEqual(commands.map(\.kind), [
            UInt32(BOTA_DEVICE_SDK_V1_COMMAND_TRANSFER_ENCRYPTED_RECORDING),
        ])
        XCTAssertEqual(
            commands.first?.fields.unsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_CAPABILITY_FLAGS)),
            UInt64(capability.capabilities.flags)
        )
        XCTAssertEqual(
            commands.first?.fields.unsigned(EncryptedUploadV2Abi.fieldTransportSessionID),
            checkpoint.transportSessionID
        )
        XCTAssertEqual(
            commands.first?.fields.compactMap { field -> String? in
                guard case let .text(id, value) = field,
                      id == UInt32(BOTA_DEVICE_SDK_V1_FIELD_SINK_ID)
                else { return nil }
                return value
            }.first,
            checkpoint.sinkID
        )
        XCTAssertEqual(
            commands.first?.fields.unsigned(EncryptedUploadV2Abi.fieldWindowPackets),
            UInt64(checkpoint.windowPackets)
        )
        XCTAssertEqual(
            commands.first?.fields.unsigned(EncryptedUploadV2Abi.fieldDataPayloadBytes),
            UInt64(checkpoint.dataPayloadBytes)
        )
    }

    func testEncryptedV2CallerCancellationCancelsTheRunningEngineBeforeCompletion() async throws {
        let runner = SuspendedTransferWorkflowRunner()
        let termination = EncryptedUploadV2TerminalOutcomeRecorder()
        let capability = Self.encryptedV2Capability
        let recording = Self.encryptedV2Recording
        let material = Self.encryptedV2Material()
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(
            runner: runner,
            recorder: TransferFacadeRecorder(),
            encryptedUploadV2Capabilities: { _ in capability },
            registerEncryptedUploadV2Material: { _, _ in },
            terminateEncryptedUploadV2Material: { _, outcome in await termination.record(outcome) }
        ))

        let task = Task {
            try? await manager.syncEncryptedRecordingV2(
                transferDevice(),
                recording: recording,
                provider: { _ in material }
            )
        }
        await waitForEncryptedV2Handshake("engine start") {
            await runner.waitUntilStarted()
        }
        task.cancel()
        await runner.waitUntilCancelled()
        await waitForEncryptedV2Handshake("engine-start cancellation completion") {
            await task.value
        }

        let commands = await runner.commands
        let cancellations = await runner.cancellations
        let outcomes = await termination.outcomes
        XCTAssertEqual(cancellations, [commands[0].cancellationID])
        XCTAssertEqual(outcomes, [.cancelled])
    }

    func testEncryptedV2OwnsSelectionAndCancelsPreparedMaterialWhenRegistrationFails() async throws {
        let runner = TransferWorkflowRunner { _ in [] }
        let cancellation = EncryptedUploadV2CancellationRecorder()
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(
            runner: runner,
            recorder: TransferFacadeRecorder(),
            encryptedUploadV2Capabilities: { _ in Self.encryptedV2Capability },
            registerEncryptedUploadV2Material: { _, _ in throw NativeHostError.missingResource("registry") }
        ))

        do {
            try await manager.syncEncryptedRecordingV2(
                transferDevice(),
                recording: Self.encryptedV2Recording,
                provider: { _ in Self.encryptedV2Material(cancellation) }
            )
            XCTFail("expected material registration to fail")
        } catch { }

        let cancellationCount = await cancellation.count
        let commands = await runner.commands
        XCTAssertEqual(cancellationCount, 1)
        XCTAssertTrue(commands.isEmpty)
    }

    func testEncryptedV2CancellationOwnsCapabilityReadBeforeProviderSelection() async throws {
        let runner = TransferWorkflowRunner { _ in [] }
        let capabilityRead = EncryptedUploadV2CapabilityReadGate()
        let selection = EncryptedUploadV2SelectionCallRecorder()
        let capability = Self.encryptedV2Capability
        let recording = Self.encryptedV2Recording
        let material = Self.encryptedV2Material()
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(
            runner: runner,
            recorder: TransferFacadeRecorder(),
            encryptedUploadV2Capabilities: { _ in await capabilityRead.read() }
        ))

        let task = Task {
            try? await manager.syncEncryptedRecordingV2(
                transferDevice(),
                recording: recording,
                provider: { _ in
                    await selection.record()
                    return material
                }
            )
        }
        await capabilityRead.waitUntilRead()
        try await manager.cancelCurrentOperation()
        await capabilityRead.resume(with: capability)
        await task.value

        let cancellations = await runner.cancellations
        let selectionCount = await selection.count
        XCTAssertEqual(cancellations.count, 0)
        XCTAssertEqual(selectionCount, 0)
    }

    func testEncryptedV2CancellationDuringEngineStartCancelsTheLateEngineOwner() async throws {
        let runner = DelayedStartTransferWorkflowRunner()
        let termination = EncryptedUploadV2TerminalOutcomeRecorder()
        let capability = Self.encryptedV2Capability
        let recording = Self.encryptedV2Recording
        let material = Self.encryptedV2Material()
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(
            runner: runner,
            recorder: TransferFacadeRecorder(),
            encryptedUploadV2Capabilities: { _ in capability },
            registerEncryptedUploadV2Material: { _, _ in },
            terminateEncryptedUploadV2Material: { _, outcome in await termination.record(outcome) }
        ))

        let task = Task {
            try? await manager.syncEncryptedRecordingV2(
                transferDevice(),
                recording: recording,
                provider: { _ in material }
            )
        }
        await runner.waitUntilStarted()
        task.cancel()
        await runner.resumeStart()
        await task.value

        let commands = await runner.commands
        let cancellations = await runner.cancellations
        let outcomes = await termination.outcomes
        XCTAssertEqual(cancellations, [commands[0].cancellationID])
        XCTAssertEqual(outcomes, [.cancelled])
    }

    func testEncryptedV2StartupCancellationRetainsSharedOperationUntilTheEngineSettles() async throws {
        let runner = DelayedStartTransferWorkflowRunner()
        let operations = DeviceOperationCoordinator()
        let capability = Self.encryptedV2Capability
        let recording = Self.encryptedV2Recording
        let material = Self.encryptedV2Material()
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(
            runner: runner,
            recorder: TransferFacadeRecorder(),
            operations: operations,
            encryptedUploadV2Capabilities: { _ in capability }
        ))

        let task = Task {
            try? await manager.syncEncryptedRecordingV2(
                transferDevice(),
                recording: recording,
                provider: { _ in material }
            )
        }
        await waitForEncryptedV2Handshake("engine startup") {
            await runner.waitUntilStarted()
        }
        try await manager.cancelCurrentOperation()

        let replacementID = UUID()
        do {
            try await operations.begin(replacementID, operation: .transferRecording)
            XCTFail("startup cancellation must retain the shared operation")
            await operations.end(replacementID)
        } catch let error as BotaSDKError {
            XCTAssertEqual(error.code, .operationInProgress)
        }

        await runner.resumeStart()
        await waitForEncryptedV2Handshake("startup cancellation settlement") {
            await task.value
        }
        try await operations.begin(UUID(), operation: .transferRecording)
    }

    func testEncryptedV2StartupCancellationPropagatesExactCompletedConfirmation() async throws {
        let runner = DelayedStartExactSettlementWorkflowRunner(settlement: .completed)
        let termination = EncryptedUploadV2TerminalOutcomeRecorder()
        let recording = Self.encryptedV2Recording
        let material = Self.encryptedV2Material()
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(
            runner: runner,
            recorder: TransferFacadeRecorder(),
            encryptedUploadV2Capabilities: { _ in Self.encryptedV2Capability },
            terminateEncryptedUploadV2Material: { _, outcome in await termination.record(outcome) }
        ))

        let task = Task.detached { @Sendable in
            try await manager.syncEncryptedRecordingV2(
                transferDevice(),
                recording: recording,
                provider: { _ in material }
            )
        }
        await waitForEncryptedV2Handshake("exact-completion engine startup") {
            await runner.waitUntilStarted()
        }
        task.cancel()
        await runner.resumeStart()
        let taskResult = await task.result

        let commands = await runner.commands
        let ordinaryCancellations = await runner.ordinaryCancellations
        let exactSettlements = await runner.exactSettlements
        let outcomes = await termination.value()
        if case let .failure(error) = taskResult { XCTFail("unexpected startup result: \(error)") }
        XCTAssertEqual(ordinaryCancellations, [])
        XCTAssertEqual(exactSettlements, [commands[0].cancellationID])
        XCTAssertEqual(outcomes, [.completed])
    }

    func testEncryptedV2StartupCancellationPropagatesExactConfirmationUncertainty() async throws {
        let runner = DelayedStartExactSettlementWorkflowRunner(settlement: .ownershipUnknown)
        let termination = EncryptedUploadV2TerminalOutcomeRecorder()
        let recording = Self.encryptedV2Recording
        let material = Self.encryptedV2Material()
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(
            runner: runner,
            recorder: TransferFacadeRecorder(),
            encryptedUploadV2Capabilities: { _ in Self.encryptedV2Capability },
            terminateEncryptedUploadV2Material: { _, outcome in await termination.record(outcome) }
        ))

        let task = Task.detached { @Sendable in
            try await manager.syncEncryptedRecordingV2(
                transferDevice(),
                recording: recording,
                provider: { _ in material }
            )
        }
        await waitForEncryptedV2Handshake("uncertain-confirmation engine startup") {
            await runner.waitUntilStarted()
        }
        task.cancel()
        await runner.resumeStart()
        let taskResult = await task.result

        let commands = await runner.commands
        let ordinaryCancellations = await runner.ordinaryCancellations
        let exactSettlements = await runner.exactSettlements
        let outcomes = await termination.value()
        guard case let .failure(error) = taskResult,
              let sdkError = error as? BotaSDKError
        else {
            return XCTFail("expected startup confirmation uncertainty")
        }
        XCTAssertEqual(sdkError.code, .uploadOwnershipUnknown)
        XCTAssertEqual(ordinaryCancellations, [])
        XCTAssertEqual(exactSettlements, [commands[0].cancellationID])
        XCTAssertEqual(outcomes, [])
    }

    func testEncryptedV2CancellationCleansLateProviderMaterialAfterFacadeOwnershipEnds() async throws {
        let runner = TransferWorkflowRunner { _ in [] }
        let provider = EncryptedUploadV2ProviderGate()
        let cancellation = EncryptedUploadV2CancellationRecorder()
        let capability = Self.encryptedV2Capability
        let recording = Self.encryptedV2Recording
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(
            runner: runner,
            recorder: TransferFacadeRecorder(),
            encryptedUploadV2Capabilities: { _ in capability }
        ))

        let task = Task {
            try? await manager.syncEncryptedRecordingV2(
                transferDevice(),
                recording: recording,
                provider: { _ in await provider.material() }
            )
        }
        await waitForEncryptedV2Handshake("provider request") {
            await provider.waitUntilRequested()
        }
        task.cancel()
        await provider.resume(with: Self.encryptedV2Material(cancellation))
        await waitForEncryptedV2Handshake("late-provider cancellation completion") {
            await task.value
        }

        let cancellationCount = await cancellation.value()
        let commands = await runner.commands
        XCTAssertEqual(cancellationCount, 1)
        XCTAssertTrue(commands.isEmpty)
    }

    func testEncryptedV2CancellationTerminatesLateRegistrySuccessExactlyOnce() async throws {
        let runner = TransferWorkflowRunner { _ in [] }
        let registration = EncryptedUploadV2RegistrationGate()
        let termination = EncryptedUploadV2TerminalOutcomeRecorder()
        let cancellation = EncryptedUploadV2CancellationRecorder()
        let capability = Self.encryptedV2Capability
        let recording = Self.encryptedV2Recording
        let material = Self.encryptedV2Material(cancellation)
        let manager = RecordingManager()
        await manager.attach(await transferRuntime(
            runner: runner,
            recorder: TransferFacadeRecorder(),
            encryptedUploadV2Capabilities: { _ in capability },
            registerEncryptedUploadV2Material: { _, _ in await registration.register() },
            terminateEncryptedUploadV2Material: { _, outcome in await termination.record(outcome) }
        ))

        let task = Task {
            try? await manager.syncEncryptedRecordingV2(
                transferDevice(),
                recording: recording,
                provider: { _ in material }
            )
        }
        await waitForEncryptedV2Handshake("material registration") {
            await registration.waitUntilRequested()
        }
        task.cancel()
        await registration.resume()
        await waitForEncryptedV2Handshake("late-registration cancellation completion") {
            await task.value
        }

        let registrationCount = await registration.count()
        let cancellationCount = await cancellation.value()
        let outcomes = await termination.value()
        let commands = await runner.commands
        XCTAssertEqual(registrationCount, 1)
        XCTAssertEqual(cancellationCount, 1)
        XCTAssertEqual(outcomes, [.cancelled])
        XCTAssertTrue(commands.isEmpty)
    }

    private static let encryptedV2Capability = EncryptedUploadV2CapabilitySnapshot(
        rawValue: Data(repeating: 0xa1, count: 24),
        sha256: Data(repeating: 0xb2, count: 32),
        capabilities: .init(
            flags: 0x7f,
            maximumSignedBlobBytes: 408,
            maximumManifestBytes: 580,
            maximumDataPayloadBytes: 160,
            maximumWindowPackets: 4,
            durableCheckpointIntervalBlocks: 1,
            maximumMissingSequences: 1
        )
    )

    private func waitForEncryptedV2Handshake(
        _ description: String,
        operation: @escaping @Sendable () async -> Void
    ) async {
        let expectation = expectation(description: description)
        Task {
            await operation()
            expectation.fulfill()
        }
        await fulfillment(of: [expectation], timeout: 1)
    }

    private static let encryptedV2Recording = EncryptedUploadV2Recording(
        uuid: "00112233-4455-6677-8899-aabbccddeeff",
        generation: 3,
        ciphertextLength: 1024,
        ciphertextSHA256: Data(repeating: 0x5a, count: 32)
    )

    private static func encryptedV2Material(
        _ cancellation: EncryptedUploadV2CancellationRecorder? = nil
    ) -> EncryptedUploadV2Material {
        .init(
            materialID: "material-id",
            recordingID: "rec_123",
            uploadSessionID: UUID(uuidString: "00112233-4455-6677-8899-aabbccddeeff")!,
            ownerRevision: 4,
            policy: .v2Required,
            authorization: Data(repeating: 0xc3, count: 408),
            stagingRequest: { _ in URLRequest(url: URL(string: "https://staging.example/upload")!) },
            submitManifest: { _, _ in },
            finalize: { _ in },
            completionReceipt: { _ in Data(repeating: 0xd4, count: 336) },
            cancel: { await cancellation?.record() }
        )
    }

    private static func hex(_ value: String) -> Data {
        Data(stride(from: 0, to: value.count, by: 2).map { offset in
            let start = value.index(value.startIndex, offsetBy: offset)
            return UInt8(value[start..<value.index(start, offsetBy: 2)], radix: 16)!
        })
    }
}

private actor EncryptedUploadV2SelectionRecorder {
    private(set) var context: EncryptedUploadV2ProviderContext?

    func record(_ context: EncryptedUploadV2ProviderContext) {
        self.context = context
    }
}

private actor EncryptedUploadV2TerminalOutcomeRecorder {
    private(set) var outcomes: [EncryptedUploadV2TerminalOutcome] = []
    func record(_ outcome: EncryptedUploadV2TerminalOutcome) { outcomes.append(outcome) }
    func value() -> [EncryptedUploadV2TerminalOutcome] { outcomes }
}

private actor EncryptedUploadV2CancellationRecorder {
    private(set) var count = 0
    func record() { count += 1 }
    func value() -> Int { count }
}

private actor EncryptedUploadV2CapabilityReadGate {
    private var continuation: CheckedContinuation<EncryptedUploadV2CapabilitySnapshot, Never>?
    private var readContinuation: CheckedContinuation<Void, Never>?
    private var didRead = false

    func read() async -> EncryptedUploadV2CapabilitySnapshot {
        didRead = true
        readContinuation?.resume()
        readContinuation = nil
        return await withCheckedContinuation { continuation = $0 }
    }

    func waitUntilRead() async {
        guard !didRead else { return }
        await withCheckedContinuation { readContinuation = $0 }
    }

    func resume(with capability: EncryptedUploadV2CapabilitySnapshot) {
        continuation?.resume(returning: capability)
        continuation = nil
    }
}

private actor EncryptedUploadV2SelectionCallRecorder {
    private(set) var count = 0
    func record() { count += 1 }
}

private actor EncryptedUploadV2ProviderGate {
    private var continuation: CheckedContinuation<EncryptedUploadV2Material, Never>?
    private var requestContinuation: CheckedContinuation<Void, Never>?
    private var requested = false

    func material() async -> EncryptedUploadV2Material {
        requested = true
        requestContinuation?.resume()
        requestContinuation = nil
        return await withCheckedContinuation { continuation = $0 }
    }

    func waitUntilRequested() async {
        guard !requested else { return }
        await withCheckedContinuation { requestContinuation = $0 }
    }

    func resume(with material: EncryptedUploadV2Material) {
        continuation?.resume(returning: material)
        continuation = nil
    }
}

private actor EncryptedUploadV2RegistrationGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var requestContinuation: CheckedContinuation<Void, Never>?
    private var requests = 0

    func register() async {
        requests += 1
        requestContinuation?.resume()
        requestContinuation = nil
        await withCheckedContinuation { continuation = $0 }
    }

    func waitUntilRequested() async {
        guard requests == 0 else { return }
        await withCheckedContinuation { requestContinuation = $0 }
    }

    func resume() {
        continuation?.resume()
        continuation = nil
    }

    func count() -> Int { requests }
}
