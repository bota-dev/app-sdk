import BotaDeviceSDKC
import Foundation

actor CoreEngineActor {
    private struct ActiveWorkflow {
        let cancellationID: CoreCancellationID
        let continuation: AsyncThrowingStream<CoreNotification, Error>.Continuation
        var confirmationInFlight = false
    }

    private let abi: CoreAbiClient
    private let host: any CoreHost
    private var active: ActiveWorkflow?
    private var isDraining = false
    private var drainRequested = false
    private var terminalWaiters: [CoreCancellationID: [CheckedContinuation<Void, Never>]] = [:]

    init(abi: CoreAbiClient, host: any CoreHost) {
        self.abi = abi
        self.host = host
    }

    func run(
        _ command: CoreCommand,
        capabilities: CoreCapabilities
    ) async -> AsyncThrowingStream<CoreNotification, Error> {
        let pair = AsyncThrowingStream<CoreNotification, Error>.makeStream()
        do {
            try abi.start(command.packet, capabilities: capabilities.rawValue)
            active = ActiveWorkflow(
                cancellationID: CoreCancellationID(command.cancellationID),
                continuation: pair.continuation
            )
            await drain()
        } catch {
            pair.continuation.finish(throwing: error)
        }
        return pair.stream
    }

    func cancel(_ id: UUID) async throws {
        let cancellation = CoreCancellationID(id)
        let confirmationInFlight = active?.cancellationID == cancellation &&
            active?.confirmationInFlight == true
        try abi.cancel(cancellationHigh: cancellation.high, cancellationLow: cancellation.low)
        if confirmationInFlight {
            await drain()
            await waitForTerminal(cancellation)
            return
        }
        await host.cancel(cancellation)
        await drain()
    }

    private func drain() async {
        guard !isDraining else {
            drainRequested = true
            return
        }
        isDraining = true
        defer { isDraining = false }

        do {
            repeat {
                drainRequested = false
                while let packet = try abi.pollOutput() {
                    if packet.kind > UInt32(BOTA_DEVICE_SDK_V1_NOTIFICATION_RANGE_START) {
                        let notification = try CoreNotification(packet: packet)
                        active?.continuation.yield(notification)
                        if notification.isTerminal {
                            active?.continuation.finish()
                            finishActive()
                        }
                        continue
                    }

                    let effect = try CoreEffect(packet: packet)
                    if effect.kind == UInt32(BOTA_DEVICE_SDK_V1_HOST_EFFECT_ENCRYPTED_UPLOAD_V2_CONFIRM_WITH_RECEIPT),
                       active?.cancellationID == effect.cancellationID
                    {
                        active?.confirmationInFlight = true
                    }
                    let events = await host.execute(effect)
                    consume(events, for: effect)
                    await Task.yield()
                }
            } while drainRequested
        } catch {
            active?.continuation.finish(throwing: error)
            finishActive()
        }
    }

    private func consume(
        _ events: AsyncThrowingStream<CoreHostEvent, Error>,
        for effect: CoreEffect
    ) {
        Task {
            do {
                for try await event in events {
                    await receive(event)
                }
            } catch {
                fail(error, cancellationID: effect.cancellationID)
            }
        }
    }

    private func receive(_ event: CoreHostEvent) async {
        do {
            try abi.dispatch(event.packet)
        } catch let error as CoreError
            where error.code == UInt32(BOTA_DEVICE_SDK_V1_ERROR_UNEXPECTED_EVENT)
        {
            return
        } catch {
            fail(
                error,
                cancellationID: CoreCancellationID(
                    high: event.cancellationHigh,
                    low: event.cancellationLow
                )
            )
            return
        }
        await drain()
    }

    private func fail(_ error: Error, cancellationID: CoreCancellationID) {
        guard active?.cancellationID == cancellationID else { return }
        active?.continuation.finish(throwing: error)
        finishActive()
    }

    private func waitForTerminal(_ cancellationID: CoreCancellationID) async {
        guard active?.cancellationID == cancellationID else { return }
        await withCheckedContinuation { continuation in
            terminalWaiters[cancellationID, default: []].append(continuation)
        }
    }

    private func finishActive() {
        guard let cancellationID = active?.cancellationID else { return }
        active = nil
        terminalWaiters.removeValue(forKey: cancellationID)?.forEach { $0.resume() }
    }
}
