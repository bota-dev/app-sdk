import BotaDeviceSDKC
import Foundation

actor CoreEngineActor {
    private struct ActiveWorkflow {
        let cancellationID: CoreCancellationID
        let continuation: AsyncThrowingStream<CoreNotification, Error>.Continuation
    }

    private let abi: CoreAbiClient
    private let host: any CoreHost
    private var active: ActiveWorkflow?
    private var isDraining = false

    init(abi: CoreAbiClient, host: any CoreHost) {
        self.abi = abi
        self.host = host
    }

    func run(
        _ command: CoreCommand,
        capabilities: CoreCapabilities
    ) -> AsyncThrowingStream<CoreNotification, Error> {
        AsyncThrowingStream { continuation in
            Task {
                await self.start(command, capabilities: capabilities, continuation: continuation)
            }
        }
    }

    func cancel(_ id: UUID) async throws {
        let cancellation = CoreCancellationID(id)
        try abi.cancel(cancellationHigh: cancellation.high, cancellationLow: cancellation.low)
        await drain()
    }

    private func start(
        _ command: CoreCommand,
        capabilities: CoreCapabilities,
        continuation: AsyncThrowingStream<CoreNotification, Error>.Continuation
    ) async {
        do {
            try abi.start(command.packet, capabilities: capabilities.rawValue)
            active = ActiveWorkflow(
                cancellationID: CoreCancellationID(command.cancellationID),
                continuation: continuation
            )
            await drain()
        } catch {
            continuation.finish(throwing: error)
        }
    }

    private func drain() async {
        guard !isDraining else { return }
        isDraining = true
        defer { isDraining = false }

        do {
            while let packet = try abi.pollOutput() {
                if packet.kind > UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_RANGE_START) {
                    let notification = try CoreNotification(packet: packet)
                    active?.continuation.yield(notification)
                    if notification.isTerminal {
                        active?.continuation.finish()
                        active = nil
                    }
                    continue
                }

                let effect = try CoreEffect(packet: packet)
                let events = await host.execute(effect)
                for try await event in events {
                    do {
                        try abi.dispatch(event.packet)
                    } catch let error as CoreError
                        where error.code == UInt32(BOTA_DEVICE_SDK_V1_ERROR_UNEXPECTED_EVENT)
                    {
                        continue
                    }
                }
            }
        } catch {
            active?.continuation.finish(throwing: error)
            active = nil
        }
    }
}
