import BotaDeviceSDKC
import Foundation

@testable import BotaAppleSDK

actor SecureWorkflowRunner: CoreWorkflowRunning {
    typealias Responses = @Sendable (CoreCommand) -> [CoreNotification]

    private let responses: Responses
    private(set) var commands: [CoreCommand] = []
    private(set) var cancelledIDs: [UUID] = []

    init(responses: @escaping Responses = secureCompletion) {
        self.responses = responses
    }

    func run(
        _ command: CoreCommand,
        capabilities: CoreCapabilities
    ) -> AsyncThrowingStream<CoreNotification, Error> {
        commands.append(command)
        let responses = responses(command)
        return AsyncThrowingStream { continuation in
            responses.forEach { continuation.yield($0) }
            continuation.finish()
        }
    }

    func cancel(_ id: UUID) async throws { cancelledIDs.append(id) }
}

actor SecureLifecycleRecorder {
    struct Write: Equatable, Sendable {
        let peripheralID: String
        let serviceUUID: String
        let characteristicUUID: String
        let data: Data
    }

    private(set) var writes: [Write] = []
    private(set) var provisioningIDs: [String] = []
    private(set) var resetIDs: [String] = []
    private(set) var unregisteredIDs: [String] = []
    private(set) var resetProvider: FactoryResetMaterialProvider?
    var pendingReset: PersistedFactoryResetResult?

    func recordWrite(_ write: Write) { writes.append(write) }
    func registerProvisioning(_ id: String) { provisioningIDs.append(id) }
    func registerReset(_ id: String, provider: @escaping FactoryResetMaterialProvider) {
        resetIDs.append(id)
        resetProvider = provider
    }
    func unregister(_ id: String) { unregisteredIDs.append(id) }
    func loadPendingReset() -> PersistedFactoryResetResult? { pendingReset }
    func setPendingReset(_ result: PersistedFactoryResetResult?) { pendingReset = result }
}

func secureRuntime(
    runner: SecureWorkflowRunner,
    recorder: SecureLifecycleRecorder
) async -> DeviceRuntime {
    let mapper = try! CoreModelMapper()
    let connection = DeviceConnectionRegistry()
    await connection.set(secureDevice())
    return DeviceRuntime(
        engine: runner,
        capabilities: [.bluetooth, .timer, .persistence, .hostMaterial],
        connection: connection,
        disconnect: { _ in },
        directWrite: { peripheralID, serviceUUID, characteristicUUID, data in
            await recorder.recordWrite(.init(
                peripheralID: peripheralID,
                serviceUUID: serviceUUID,
                characteristicUUID: characteristicUUID,
                data: data
            ))
        },
        serializeConnectionSettings: { settings, model in
            try mapper.serializeConnectionSettings(settings, model: model)
        },
        encodeDeviceCommand: { try mapper.encodeDeviceCommand($0) },
        registerProvisioning: { id, _ in await recorder.registerProvisioning(id) },
        registerFactoryReset: { id, provider in await recorder.registerReset(id, provider: provider) },
        unregisterMaterial: { id in await recorder.unregister(id) },
        registerFactoryResetGeneration: { _, _ in },
        loadPendingFactoryReset: { await recorder.loadPendingReset() }
    )
}

func secureDevice(model: DeviceType = .botaNote) -> ConnectedDevice {
    ConnectedDevice(
        id: "00000000-0000-0000-0000-000000000001",
        serialNumber: "EVFXXW67KP",
        deviceType: model,
        firmwareVersion: "1.0.17",
        isProvisioned: true,
        connectionState: .connected,
        mtu: 185
    )
}

func secureCompletion(_ command: CoreCommand) -> [CoreNotification] {
    [secureNotification(
        UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_COMPLETED),
        operation: command.kind == UInt32(BOTA_DEVICE_SDK_V1_COMMAND_PROVISION)
            ? UInt32(BOTA_DEVICE_SDK_V1_OPERATION_PROVISION)
            : UInt32(BOTA_DEVICE_SDK_V1_OPERATION_FACTORY_RESET)
    )]
}

func secureNotification(
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

extension Array where Element == CoreField {
    func secureText(_ id: UInt32) -> String? {
        for field in self {
            if case let .text(fieldID, value) = field, fieldID == id { return value }
        }
        return nil
    }
}
