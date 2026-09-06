import BotaDeviceSDKC
import Foundation

@testable import BotaAppleSDK

actor TransferWorkflowRunner: CoreWorkflowRunning {
    typealias Responses = @Sendable (CoreCommand) -> [CoreNotification]

    private let responses: Responses
    private(set) var commands: [CoreCommand] = []
    private(set) var cancellations: [UUID] = []

    init(responses: @escaping Responses) { self.responses = responses }

    func run(
        _ command: CoreCommand,
        capabilities: CoreCapabilities
    ) -> AsyncThrowingStream<CoreNotification, Error> {
        commands.append(command)
        let values = responses(command)
        return AsyncThrowingStream { continuation in
            values.forEach { continuation.yield($0) }
            continuation.finish()
        }
    }

    func cancel(_ id: UUID) async throws { cancellations.append(id) }
}

actor SuspendedTransferWorkflowRunner: CoreWorkflowRunning {
    private(set) var commands: [CoreCommand] = []
    private(set) var cancellations: [UUID] = []
    private var continuation: AsyncThrowingStream<CoreNotification, Error>.Continuation?
    private var startContinuation: CheckedContinuation<Void, Never>?
    private var cancellationContinuation: CheckedContinuation<Void, Never>?

    func run(
        _ command: CoreCommand,
        capabilities: CoreCapabilities
    ) -> AsyncThrowingStream<CoreNotification, Error> {
        commands.append(command)
        let pair = AsyncThrowingStream<CoreNotification, Error>.makeStream()
        continuation = pair.continuation
        startContinuation?.resume()
        startContinuation = nil
        return pair.stream
    }

    func cancel(_ id: UUID) async throws {
        cancellations.append(id)
        continuation?.finish()
        cancellationContinuation?.resume()
        cancellationContinuation = nil
    }

    func waitUntilStarted() async {
        guard commands.isEmpty else { return }
        await withCheckedContinuation { startContinuation = $0 }
    }

    func waitUntilCancelled() async {
        guard cancellations.isEmpty else { return }
        await withCheckedContinuation { cancellationContinuation = $0 }
    }
}

actor DelayedStartTransferWorkflowRunner: CoreWorkflowRunning {
    private(set) var commands: [CoreCommand] = []
    private(set) var cancellations: [UUID] = []
    private var startContinuation: CheckedContinuation<Void, Never>?
    private var resumeContinuation: CheckedContinuation<Void, Never>?
    private var notificationContinuation: AsyncThrowingStream<CoreNotification, Error>.Continuation?

    func run(
        _ command: CoreCommand,
        capabilities: CoreCapabilities
    ) async -> AsyncThrowingStream<CoreNotification, Error> {
        commands.append(command)
        startContinuation?.resume()
        startContinuation = nil
        await withCheckedContinuation { resumeContinuation = $0 }
        let pair = AsyncThrowingStream<CoreNotification, Error>.makeStream()
        notificationContinuation = pair.continuation
        pair.continuation.yield(transferCompleted(operation: 4))
        pair.continuation.finish()
        return pair.stream
    }

    func cancel(_ id: UUID) async throws {
        cancellations.append(id)
        notificationContinuation?.finish()
    }

    func waitUntilStarted() async {
        guard commands.isEmpty else { return }
        await withCheckedContinuation { startContinuation = $0 }
    }

    func resumeStart() {
        resumeContinuation?.resume()
        resumeContinuation = nil
    }
}

actor DelayedStartExactSettlementWorkflowRunner: CoreWorkflowRunning {
    enum Settlement: Sendable {
        case completed
        case ownershipUnknown
        case claimedCancellationFailed
    }

    private let settlement: Settlement
    private(set) var commands: [CoreCommand] = []
    private(set) var ordinaryCancellations: [UUID] = []
    private(set) var exactSettlements: [UUID] = []
    private var startContinuation: CheckedContinuation<Void, Never>?
    private var resumeContinuation: CheckedContinuation<Void, Never>?

    init(settlement: Settlement) { self.settlement = settlement }

    func run(
        _ command: CoreCommand,
        capabilities: CoreCapabilities
    ) async -> AsyncThrowingStream<CoreNotification, Error> {
        commands.append(command)
        startContinuation?.resume()
        startContinuation = nil
        await withCheckedContinuation { resumeContinuation = $0 }
        return AsyncThrowingStream { $0.finish() }
    }

    func cancel(_ id: UUID) async throws { ordinaryCancellations.append(id) }

    func cancelAndReportExactSettlement(_ id: UUID) async throws -> Bool {
        exactSettlements.append(id)
        switch settlement {
        case .completed:
            return true
        case .ownershipUnknown:
            throw BotaSDKError(
                code: .uploadOwnershipUnknown,
                operation: .transferRecording,
                retryable: false,
                detail: "CONFIRM succeeded but cleanup is uncertain"
            )
        case .claimedCancellationFailed:
            throw BotaSDKError(
                code: .internal,
                operation: .transferRecording,
                retryable: false,
                detail: "cancellation failed after the host claimed ownership"
            )
        }
    }

    func waitUntilStarted() async {
        guard commands.isEmpty else { return }
        await withCheckedContinuation { startContinuation = $0 }
    }

    func resumeStart() {
        resumeContinuation?.resume()
        resumeContinuation = nil
    }
}

actor TransferFacadeRecorder {
    struct Write: Equatable, Sendable {
        let service: String
        let characteristic: String
        let data: Data
    }

    private(set) var writes: [Write] = []
    private(set) var subscriptions: [String] = []
    private(set) var unsubscriptions: [String] = []
    private(set) var firmwareRegistrations: [UInt64] = []
    private(set) var firmwareUnregistrations: [UInt64] = []
    private(set) var streamingRegistrations: [String] = []
    private(set) var streamingUnregistrations: [String] = []

    func write(service: String, characteristic: String, data: Data) {
        writes.append(.init(service: service, characteristic: characteristic, data: data))
    }
    func subscribe(_ characteristic: String) { subscriptions.append(characteristic) }
    func unsubscribe(_ characteristic: String) { unsubscriptions.append(characteristic) }
    func registerFirmware(_ id: UInt64) { firmwareRegistrations.append(id) }
    func unregisterFirmware(_ id: UInt64) { firmwareUnregistrations.append(id) }
    func registerStreaming(_ id: String) { streamingRegistrations.append(id) }
    func unregisterStreaming(_ id: String) { streamingUnregistrations.append(id) }
}

func transferRuntime(
    runner: any CoreWorkflowRunning,
    recorder: TransferFacadeRecorder,
    operations: DeviceOperationCoordinator = DeviceOperationCoordinator(),
    notificationData: Data = Data(),
    encryptedUploadV2Capabilities: @escaping @Sendable
        (String) async throws -> EncryptedUploadV2CapabilitySnapshot = { _ in
            throw NativeHostError.missingResource("encrypted upload v2 capabilities")
        },
    encryptedUploadV2Checkpoint: @escaping @Sendable
        (String, String, UInt32) async throws -> EncryptedUploadV2Checkpoint? = { _, _, _ in nil },
    encryptedUploadV2MaximumWriteLength: @escaping @Sendable (String) async throws -> Int = { _ in 185 },
    registerEncryptedUploadV2Material: @escaping @Sendable
        (String, EncryptedUploadV2Material) async throws -> Void = { _, _ in },
    terminateEncryptedUploadV2Material: @escaping @Sendable
        (String, EncryptedUploadV2TerminalOutcome) async -> Void = { _, _ in }
) async -> DeviceRuntime {
    let mapper = try! CoreModelMapper()
    let connection = DeviceConnectionRegistry()
    await connection.set(transferDevice())
    return DeviceRuntime(
        engine: runner,
        capabilities: .all,
        connection: connection,
        operations: operations,
        disconnect: { _ in },
        directWrite: { _, service, characteristic, data in
            await recorder.write(service: service, characteristic: characteristic, data: data)
        },
        directSubscribe: { _, _, characteristic in
            await recorder.subscribe(characteristic)
            return AsyncThrowingStream { continuation in
                continuation.yield(notificationData)
                continuation.finish()
            }
        },
        directUnsubscribe: { _, _, characteristic in await recorder.unsubscribe(characteristic) },
        readEncryptedUploadV2Capabilities: encryptedUploadV2Capabilities,
        encryptedUploadV2Checkpoint: encryptedUploadV2Checkpoint,
        encryptedUploadV2MaximumWriteLength: encryptedUploadV2MaximumWriteLength,
        registerEncryptedUploadV2Material: registerEncryptedUploadV2Material,
        terminateEncryptedUploadV2Material: terminateEncryptedUploadV2Material,
        parseRecordingList: { try mapper.parseRecordingList($0) },
        createTransferCommand: { try mapper.createTransferCommand($0) },
        recordingFileURL: { sinkID in URL(fileURLWithPath: "/tmp/\(sinkID).recording") },
        registerStreamingSink: { sinkID, _, _, _, _ in await recorder.registerStreaming(sinkID) },
        unregisterStreamingSink: { sinkID in await recorder.unregisterStreaming(sinkID) },
        registerFirmwareDownload: { id, _, _ in await recorder.registerFirmware(id) },
        unregisterFirmwareDownload: { id in await recorder.unregisterFirmware(id) },
        firmwareFileURL: { id in URL(fileURLWithPath: "/tmp/firmware-\(id).bin") }
    )
}

func transferDevice() -> ConnectedDevice {
    ConnectedDevice(
        id: "00000000-0000-0000-0000-000000000002",
        serialNumber: "EVFXXW67KP",
        deviceType: .botaNote,
        firmwareVersion: "1.0.17",
        isProvisioned: true,
        connectionState: .connected,
        mtu: 185
    )
}

func transferNotification(
    _ kind: UInt32,
    operation: UInt32,
    fields: [CoreField] = []
) -> CoreNotification {
    try! CoreNotification(packet: CorePacket(
        kind: kind,
        operation: operation,
        requestID: 1,
        cancellationHigh: 1,
        cancellationLow: 2,
        fields: fields
    ))
}

func transferCompleted(operation: UInt32) -> CoreNotification {
    transferNotification(UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_COMPLETED), operation: operation)
}
