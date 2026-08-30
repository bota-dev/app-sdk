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

    func write(service: String, characteristic: String, data: Data) {
        writes.append(.init(service: service, characteristic: characteristic, data: data))
    }
    func subscribe(_ characteristic: String) { subscriptions.append(characteristic) }
    func unsubscribe(_ characteristic: String) { unsubscriptions.append(characteristic) }
    func registerFirmware(_ id: UInt64) { firmwareRegistrations.append(id) }
    func unregisterFirmware(_ id: UInt64) { firmwareUnregistrations.append(id) }
}

func transferRuntime(
    runner: TransferWorkflowRunner,
    recorder: TransferFacadeRecorder,
    notificationData: Data = Data()
) async -> DeviceRuntime {
    let mapper = try! CoreModelMapper()
    let connection = DeviceConnectionRegistry()
    await connection.set(transferDevice())
    return DeviceRuntime(
        engine: runner,
        capabilities: .all,
        connection: connection,
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
        parseRecordingList: { try mapper.parseRecordingList($0) },
        createTransferCommand: { try mapper.createTransferCommand($0) },
        recordingFileURL: { sinkID in URL(fileURLWithPath: "/tmp/\(sinkID).recording") },
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
