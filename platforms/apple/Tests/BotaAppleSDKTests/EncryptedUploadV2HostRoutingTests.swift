import BotaDeviceSDKC
import Foundation
import XCTest

@testable import BotaAppleSDK

final class EncryptedUploadV2HostRoutingTests: XCTestCase {
    func testCommandUsesOnlyOpaqueIdentifiersBoundsAndDigests() throws {
        let cancellationID = try XCTUnwrap(UUID(uuidString: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))
        let uploadSessionID = try XCTUnwrap(UUID(uuidString: "00112233-4455-6677-8899-aabbccddeeff"))
        let command = CoreCommand.transferEncryptedRecording(
            .init(
                serialNumber: "EVFXXW67KP",
                recordingUUID: "ffeeddccbbaa99887766554433221100",
                recordingGeneration: 7,
                storageFormat: 3,
                uploadSessionID: uploadSessionID,
                ownerRevision: 9,
                transportSessionID: 11,
                materialID: "material-id",
                sinkID: "sink-id",
                profile: .encryptedUploadV2,
                securityPolicy: .v2Required,
                capabilities: .init(
                    flags: 0x7f,
                    maximumSignedBlobBytes: 1024,
                    maximumManifestBytes: 512,
                    maximumDataPayloadBytes: 180,
                    maximumWindowPackets: 8,
                    durableCheckpointIntervalBlocks: 4,
                    maximumMissingSequences: 3
                ),
                windowPackets: 4,
                dataPayloadBytes: 160,
                ciphertextLength: 4096,
                ciphertextSHA256: Data(repeating: 0x5a, count: 32)
            ),
            cancellationID: cancellationID
        )

        XCTAssertEqual(command.kind, UInt32(BOTA_DEVICE_SDK_V1_COMMAND_TRANSFER_ENCRYPTED_RECORDING))
        XCTAssertEqual(command.cancellationID, cancellationID)
        let expectedFields: [CoreField] = [
            .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SERIAL_NUMBER), value: "EVFXXW67KP"),
            .text(
                id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RECORDING_UUID),
                value: "ffeeddccbbaa99887766554433221100"
            ),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RECORDING_GENERATION), value: 7),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_STORAGE_FORMAT), value: 3),
            .bytes(
                id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_UPLOAD_SESSION_UUID),
                value: Data([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
                             0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])
            ),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_OWNER_REVISION), value: 9),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TRANSPORT_SESSION_ID), value: 11),
            .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_MATERIAL_ID), value: "material-id"),
            .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_SINK_ID), value: "sink-id"),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_UPLOAD_PROFILE), value: 3),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_UPLOAD_SECURITY_POLICY), value: 3),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CAPABILITY_FLAGS), value: 0x7f),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_MAX_SIGNED_BLOB_BYTES), value: 1024),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_MAX_MANIFEST_BYTES), value: 512),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_MAX_DATA_PAYLOAD_BYTES), value: 180),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_MAX_WINDOW_PACKETS), value: 8),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CHECKPOINT_INTERVAL), value: 4),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_MAX_MISSING_SEQUENCES), value: 3),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_WINDOW_PACKETS), value: 4),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DATA_PAYLOAD_BYTES), value: 160),
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CIPHERTEXT_LENGTH), value: 4096),
            .bytes(
                id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CIPHERTEXT_SHA256),
                value: Data(repeating: 0x5a, count: 32)
            ),
        ]
        XCTAssertEqual(command.fields, expectedFields)
        XCTAssertFalse(command.fields.contains { field in
            switch field {
            case let .bytes(id, _), let .text(id, _):
                return id == UInt32(BOTA_DEVICE_SDK_V1_FIELD_PAYLOAD)
            case .unsigned, .signed, .bool:
                return false
            }
        })
    }

    func testExecutorRoutesEveryEncryptedUploadV2Effect() async throws {
        let recorder = EncryptedUploadV2PortRecorder()
        let executor = makeExecutor(encryptedUploadV2: ProbeEncryptedUploadV2Port(recorder: recorder))

        for vector in EncryptedUploadV2EffectVector.all {
            let effect = try CoreEffect(packet: vector.packet)
            let stream = await executor.execute(effect)
            var events: [CoreHostEvent] = []
            for try await event in stream { events.append(event) }

            let recordedKind = await recorder.removeFirst()
            XCTAssertEqual(recordedKind, vector.packet.kind)
            XCTAssertEqual(events.map(\.kind), vector.eventKinds)
            XCTAssertTrue(events.allSatisfy {
                $0.operation == vector.packet.operation
                    && $0.requestID == vector.packet.requestID
                    && $0.cancellationHigh == vector.packet.cancellationHigh
                    && $0.cancellationLow == vector.packet.cancellationLow
            })
        }
    }

    func testExecutorPreservesTypedEncryptedUploadV2Failure() async throws {
        let executor = makeExecutor(encryptedUploadV2: FailingEncryptedUploadV2Port())
        let vector = EncryptedUploadV2EffectVector.named("prepare_session")
        let stream = await executor.execute(try CoreEffect(packet: vector.packet))
        var events: [CoreHostEvent] = []
        for try await event in stream { events.append(event) }

        XCTAssertEqual(events, [CoreHostEvent(
            effect: try CoreEffect(packet: vector.packet),
            kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_FAILED),
            fields: [
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ERROR_CODE), value: 18),
                .bool(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RETRYABLE), value: false),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PROTOCOL_STATUS), value: 0x0085),
                .text(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ERROR_DETAIL), value: "ciphertext digest mismatch"),
            ]
        )])
    }

    func testDefaultExecutorFailsClosedBeforeNativeV2Work() async throws {
        let executor = HostEffectExecutor(
            bluetooth: EmptyAppleHostPort(),
            persistence: EmptyAppleHostPort(),
            network: EmptyAppleHostPort(),
            material: EmptyAppleHostPort(),
            recordingSink: EmptyAppleHostPort(),
            firmwareBlob: EmptyAppleHostPort()
        )
        let vector = EncryptedUploadV2EffectVector.named("load_checkpoint")
        let effect = try CoreEffect(packet: vector.packet)
        let stream = await executor.execute(effect)
        var events: [CoreHostEvent] = []
        for try await event in stream { events.append(event) }

        XCTAssertEqual(events, [CoreHostEvent(
            effect: effect,
            kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_FAILED),
            fields: [
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ERROR_CODE), value: 7),
                .bool(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RETRYABLE), value: false),
                .text(
                    id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_ERROR_DETAIL),
                    value: "encrypted upload v2 native host is not configured"
                ),
            ]
        )])
    }

    func testMapsEncryptedUploadV2StagedNotification() throws {
        let packet = CorePacket(
            kind: UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_ENCRYPTED_UPLOAD_V2_STAGED),
            operation: UInt32(BOTA_DEVICE_SDK_V1_OPERATION_TRANSFER_RECORDING),
            requestID: 0,
            cancellationHigh: 1,
            cancellationLow: 2,
            fields: []
        )

        let notification = try CoreNotification(packet: packet)

        XCTAssertEqual(notification.kind, .encryptedUploadV2Staged)
        XCTAssertFalse(notification.isTerminal)
    }

    func testRealCoreEnginePreservesStagingBeforeReceiptAndConfirmation() async throws {
        let host = EncryptedUploadV2EngineHost()
        let engine = CoreEngineActor(abi: try CoreAbiClient(), host: host)
        let uploadSessionID = try XCTUnwrap(UUID(uuidString: "00112233-4455-6677-8899-aabbccddeeff"))
        let command = CoreCommand.transferEncryptedRecording(.init(
            serialNumber: "EVFXXW67KP",
            recordingUUID: "ffeeddcc-bbaa-9988-7766-554433221100",
            recordingGeneration: 7,
            storageFormat: 3,
            uploadSessionID: uploadSessionID,
            ownerRevision: 9,
            transportSessionID: 11,
            materialID: "material-id",
            sinkID: "sink-id",
            profile: .encryptedUploadV2,
            securityPolicy: .v2Required,
            capabilities: .init(
                flags: 0x7f,
                maximumSignedBlobBytes: 1024,
                maximumManifestBytes: 1024,
                maximumDataPayloadBytes: 180,
                maximumWindowPackets: 8,
                durableCheckpointIntervalBlocks: 4,
                maximumMissingSequences: 3
            ),
            windowPackets: 4,
            dataPayloadBytes: 160,
            ciphertextLength: 4096,
            ciphertextSHA256: Data(repeating: 0x5a, count: 32)
        ))

        let stream = await engine.run(command, capabilities: .all)
        var notifications: [CoreNotification] = []
        for try await notification in stream { notifications.append(notification) }

        XCTAssertEqual(notifications.map(\.kind), [.started, .encryptedUploadV2Staged, .completed])
        let staged = try XCTUnwrap(notifications.first { $0.kind == .encryptedUploadV2Staged })
        XCTAssertFalse(staged.packet.fields.contains { field in
            switch field {
            case let .bytes(id, _), let .text(id, _):
                return id == UInt32(BOTA_DEVICE_SDK_V1_FIELD_PAYLOAD)
            case .unsigned, .signed, .bool:
                return false
            }
        })
        let effectKinds = await host.effectKinds
        XCTAssertEqual(effectKinds, [
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_LOAD_CHECKPOINT),
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_TRUNCATE_SINK),
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_PREPARE_SESSION),
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_START_TRANSFER),
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_STAGE_ARTIFACTS),
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_AWAIT_RECEIPT),
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_CONFIRM_WITH_RECEIPT),
            UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_DELETE_CHECKPOINT),
        ])
    }

    private func makeExecutor(
        encryptedUploadV2: any EncryptedUploadV2Host
    ) -> HostEffectExecutor {
        HostEffectExecutor(
            bluetooth: EmptyAppleHostPort(),
            persistence: EmptyAppleHostPort(),
            network: EmptyAppleHostPort(),
            material: EmptyAppleHostPort(),
            recordingSink: EmptyAppleHostPort(),
            firmwareBlob: EmptyAppleHostPort(),
            encryptedUploadV2: encryptedUploadV2
        )
    }
}

private actor EncryptedUploadV2EngineHost: CoreHost {
    private(set) var effectKinds: [UInt32] = []

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEvent, Error> {
        effectKinds.append(effect.kind)
        let events: [CoreHostEvent]
        switch effect {
        case .encryptedUploadV2LoadCheckpoint:
            events = [.init(
                effect: effect,
                kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_CHECKPOINT_LOADED)
            )]
        case .encryptedUploadV2TruncateSink:
            events = [.init(
                effect: effect,
                kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_SINK_TRUNCATED)
            )]
        case .encryptedUploadV2PrepareSession:
            events = [.init(
                effect: effect,
                kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_SESSION_PREPARED),
                fields: [.bytes(
                    id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_AUTHORIZATION_SHA256),
                    value: Data(repeating: 0x66, count: 32)
                )]
            )]
        case .encryptedUploadV2StartTransfer:
            events = [
                .init(
                    effect: effect,
                    kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_TRANSFER_STARTED)
                ),
                .init(
                    effect: effect,
                    kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_TRANSFER_COMPLETED),
                    fields: [
                        .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CIPHERTEXT_LENGTH), value: 4096),
                        .bytes(
                            id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_CIPHERTEXT_SHA256),
                            value: Data(repeating: 0x5a, count: 32)
                        ),
                        .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_MANIFEST_LENGTH), value: 580),
                        .bytes(
                            id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_MANIFEST_SHA256),
                            value: Data(repeating: 0x55, count: 32)
                        ),
                        .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_BLOCK_COUNT), value: 1),
                    ]
                ),
            ]
        case .encryptedUploadV2StageArtifacts:
            events = [.init(
                effect: effect,
                kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_ARTIFACTS_STAGED)
            )]
        case .encryptedUploadV2AwaitReceipt:
            events = [.init(
                effect: effect,
                kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_RECEIPT_ACCEPTED),
                fields: [.bytes(
                    id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_RECEIPT_SHA256),
                    value: Data(repeating: 0x77, count: 32)
                )]
            )]
        case .encryptedUploadV2ConfirmWithReceipt:
            events = [.init(
                effect: effect,
                kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_RECORDING_CONFIRMED)
            )]
        case .encryptedUploadV2DeleteCheckpoint:
            events = []
        default:
            events = []
        }
        return AsyncThrowingStream { continuation in
            events.forEach { continuation.yield($0) }
            continuation.finish()
        }
    }
}

private struct EmptyAppleHostPort:
    BluetoothHost, PersistenceHost, NetworkHost, MaterialHost, RecordingSinkHost, FirmwareBlobHost
{
    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        AsyncThrowingStream { $0.finish() }
    }
}

private actor EncryptedUploadV2PortRecorder {
    private var values: [UInt32] = []
    func record(_ value: UInt32) { values.append(value) }
    func removeFirst() -> UInt32? { values.isEmpty ? nil : values.removeFirst() }
}

private struct ProbeEncryptedUploadV2Port: EncryptedUploadV2Host {
    let recorder: EncryptedUploadV2PortRecorder

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        await recorder.record(effect.kind)
        let vector = EncryptedUploadV2EffectVector.all.first { $0.packet.kind == effect.kind }!
        return AsyncThrowingStream { continuation in
            vector.eventKinds.forEach { continuation.yield(.init(kind: $0)) }
            continuation.finish()
        }
    }
}

private struct FailingEncryptedUploadV2Port: EncryptedUploadV2Host {
    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish(throwing: EncryptedUploadV2HostFailure(
                errorCode: UInt32(BOTA_DEVICE_SDK_V1_ERROR_INTEGRITY_FAILED),
                retryable: false,
                protocolStatus: 0x0085,
                detail: "ciphertext digest mismatch"
            ))
        }
    }
}

private struct EncryptedUploadV2EffectVector {
    let name: String
    let packet: CorePacket
    let eventKinds: [UInt32]

    static func named(_ name: String) -> Self { all.first { $0.name == name }! }

    static let all: [Self] = {
        let operation = UInt32(BOTA_DEVICE_SDK_V1_OPERATION_TRANSFER_RECORDING)
        var requestID: UInt64 = 1
        func make(_ name: String, _ kind: UInt32, _ eventKinds: [UInt32]) -> Self {
            defer { requestID += 1 }
            return Self(
                name: name,
                packet: CorePacket(
                    kind: kind,
                    operation: operation,
                    requestID: requestID,
                    cancellationHigh: 21,
                    cancellationLow: 22,
                    fields: []
                ),
                eventKinds: eventKinds
            )
        }
        let e: (UInt32) -> [UInt32] = { [$0] }
        return [
            make(
                "load_checkpoint",
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_LOAD_CHECKPOINT),
                e(UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_CHECKPOINT_LOADED))
            ),
            make("delete_checkpoint", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_DELETE_CHECKPOINT), []),
            make(
                "truncate_sink",
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_TRUNCATE_SINK),
                e(UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_SINK_TRUNCATED))
            ),
            make(
                "prepare_session",
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_PREPARE_SESSION),
                e(UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_SESSION_PREPARED))
            ),
            make(
                "start_transfer",
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_START_TRANSFER),
                [
                    UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_TRANSFER_STARTED),
                    UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_WINDOW_STAGED),
                    UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_TRANSFER_COMPLETED),
                ]
            ),
            make(
                "repair_window",
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_REPAIR_WINDOW),
                e(UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_WINDOW_STAGED))
            ),
            make(
                "save_checkpoint",
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_SAVE_CHECKPOINT),
                e(UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_CHECKPOINT_SAVED))
            ),
            make(
                "acknowledge_window",
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_ACKNOWLEDGE_WINDOW),
                e(UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_WINDOW_ACKNOWLEDGED))
            ),
            make(
                "stage_artifacts",
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_STAGE_ARTIFACTS),
                e(UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_ARTIFACTS_STAGED))
            ),
            make(
                "await_receipt",
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_AWAIT_RECEIPT),
                e(UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_RECEIPT_ACCEPTED))
            ),
            make(
                "confirm_with_receipt",
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_CONFIRM_WITH_RECEIPT),
                e(UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_ENCRYPTED_UPLOAD_V2_RECORDING_CONFIRMED))
            ),
            make("abort", UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_ABORT), []),
        ]
    }()
}
