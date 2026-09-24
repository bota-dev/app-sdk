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
    private var drainRequested = false
    private var terminals: [CoreCancellationID: CoreNotification] = [:]
    private var terminalWaiters: [CoreCancellationID: [CheckedContinuation<CoreNotification?, Never>]] = [:]

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
            terminals.removeAll()
            await drain()
        } catch {
            pair.continuation.finish(throwing: error)
        }
        return pair.stream
    }

    func cancel(_ id: UUID) async throws {
        _ = try await cancelAndReportExactSettlement(id)
    }

    func cancelAndReportExactSettlement(_ id: UUID) async throws -> Bool {
        let cancellation = CoreCancellationID(id)
        let confirmationAttempted = await host.confirmationAttemptedOrClaimCancellation(cancellation)
        if confirmationAttempted {
            guard let terminal = await waitForTerminal(cancellation) else {
                throw BotaSDKError(
                    code: .uploadOwnershipUnknown,
                    operation: .transferRecording,
                    retryable: false,
                    detail: "CONFIRM was attempted but its exact terminal settlement is unavailable"
                )
            }
            switch terminal.kind {
            case .completed:
                return true
            case .failed:
                throw workflowError(terminal)
            default:
                throw BotaSDKError(
                    code: .uploadOwnershipUnknown,
                    operation: .transferRecording,
                    retryable: false,
                    detail: "CONFIRM did not settle as completed or ownership-uncertain"
                )
            }
        }
        try abi.cancel(cancellationHigh: cancellation.high, cancellationLow: cancellation.low)
        await host.cancel(cancellation)
        await drain()
        return false
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
                            finishActive(notification)
                        }
                        continue
                    }

                    let effect = try CoreEffect(packet: packet)
                    let events = await host.execute(effect)
                    consume(events, for: effect)
                    await Task.yield()
                }
            } while drainRequested
        } catch {
            active?.continuation.finish(throwing: error)
            finishActive(nil)
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
        finishActive(nil)
    }

    private func waitForTerminal(_ cancellationID: CoreCancellationID) async -> CoreNotification? {
        if let terminal = terminals[cancellationID] { return terminal }
        guard active?.cancellationID == cancellationID else { return nil }
        return await withCheckedContinuation { continuation in
            terminalWaiters[cancellationID, default: []].append(continuation)
        }
    }

    private func finishActive(_ terminal: CoreNotification?) {
        guard let cancellationID = active?.cancellationID else { return }
        active = nil
        if let terminal { terminals[cancellationID] = terminal }
        terminalWaiters.removeValue(forKey: cancellationID)?.forEach { $0.resume(returning: terminal) }
    }
}
