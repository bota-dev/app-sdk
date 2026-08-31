import BotaAppleSDK
import Foundation

protocol BotaDeviceSDKAppleLogClient: Sendable {
    func streamLogs(
        _ device: ConnectedDevice
    ) async throws -> AsyncThrowingStream<DeviceLogLine, Error>
    func stop() async throws
}

struct BotaDeviceSDKSharedAppleLogClient: BotaDeviceSDKAppleLogClient {
    private let logs: DeviceLogManager

    init(client: BotaDeviceClient = .shared) {
        logs = client.logs
    }

    func streamLogs(
        _ device: ConnectedDevice
    ) async throws -> AsyncThrowingStream<DeviceLogLine, Error> {
        try await logs.streamLogs(device)
    }

    func stop() async throws {
        try await logs.stop()
    }
}

actor BotaDeviceSDKAppleLogs {
    private struct ActiveStream {
        let id: UUID
        let task: Task<Void, Never>
    }

    private let client: any BotaDeviceSDKAppleLogClient
    private var activeStream: ActiveStream?

    init(client: any BotaDeviceSDKAppleLogClient = BotaDeviceSDKSharedAppleLogClient()) {
        self.client = client
    }

    func start(
        _ device: ConnectedDevice,
        onLine: @escaping @Sendable (DeviceLogLine) -> Void,
        onError: @escaping @Sendable (Error) -> Void = { _ in }
    ) async throws {
        await stop()
        let stream = try await client.streamLogs(device)
        let id = UUID()
        let task = Task {
            do {
                for try await line in stream {
                    try Task.checkCancellation()
                    onLine(line)
                }
            } catch is CancellationError {
                // Explicit stop is not a log-stream failure.
            } catch {
                onError(error)
            }
            streamFinished(id: id)
        }
        activeStream = ActiveStream(id: id, task: task)
    }

    func stop() async {
        guard let stream = activeStream else { return }
        activeStream = nil
        stream.task.cancel()
        try? await client.stop()
        await stream.task.value
    }

    private func streamFinished(id: UUID) {
        if activeStream?.id == id {
            activeStream = nil
        }
    }
}
