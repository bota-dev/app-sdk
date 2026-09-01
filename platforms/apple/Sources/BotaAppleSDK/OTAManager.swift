import BotaDeviceSDKC
@preconcurrency import Foundation

public struct FirmwareImage: @unchecked Sendable {
    public let version: String
    public let sizeBytes: UInt32
    public let crc32: UInt32
    public let downloadID: UInt64
    public let request: URLRequest

    public init(version: String, sizeBytes: UInt32, crc32: UInt32, downloadID: UInt64, request: URLRequest) {
        self.version = version
        self.sizeBytes = sizeBytes
        self.crc32 = crc32
        self.downloadID = downloadID
        self.request = request
    }
}

public actor OTAManager {
    private var runtime: DeviceRuntime?
    private var activeCancellationID: UUID?
    private var activeDownloadID: UInt64?
    private var activeTask: Task<Void, Never>?

    public init() {}

    func attach(_ runtime: DeviceRuntime) { self.runtime = runtime }

    func detach() async {
        activeTask?.cancel()
        if let id = activeCancellationID {
            try? await runtime?.engine.cancel(id)
            await runtime?.operations.end(id)
        }
        if let downloadID = activeDownloadID {
            await runtime?.unregisterFirmwareDownload(downloadID)
        }
        activeTask = nil
        activeCancellationID = nil
        activeDownloadID = nil
        runtime = nil
    }

    public func updateFirmware(
        _ device: ConnectedDevice,
        image: FirmwareImage
    ) async throws -> AsyncThrowingStream<FirmwareUpdateProgress, Error> {
        guard let runtime else { throw facadeNotConfigured() }
        try await runtime.connection.require(device)
        let command = CoreCommand.updateFirmware(
            serialNumber: device.serialNumber,
            version: image.version,
            sizeBytes: image.sizeBytes,
            crc32: image.crc32,
            downloadID: image.downloadID
        )
        guard activeCancellationID == nil else {
            throw BotaSDKError(
                code: .operationInProgress,
                operation: .updateFirmware,
                retryable: false,
                detail: "another firmware update is already active"
            )
        }
        try await runtime.operations.begin(command.cancellationID, operation: .updateFirmware)
        do {
            try await runtime.registerFirmwareDownload(
                image.downloadID,
                image.request,
                runtime.firmwareFileURL(image.downloadID)
            )
        } catch {
            await runtime.operations.end(command.cancellationID)
            throw error
        }
        activeCancellationID = command.cancellationID
        activeDownloadID = image.downloadID
        let pair = AsyncThrowingStream<FirmwareUpdateProgress, Error>.makeStream()
        let task = Task {
            await self.consume(
                command,
                downloadID: image.downloadID,
                runtime: runtime,
                continuation: pair.continuation
            )
        }
        activeTask = task
        pair.continuation.onTermination = { @Sendable _ in
            Task { await self.cancel(command.cancellationID, downloadID: image.downloadID) }
        }
        return pair.stream
    }

    public func cancelCurrentOperation() async throws {
        guard let id = activeCancellationID, let runtime else { return }
        activeTask?.cancel()
        try await runtime.engine.cancel(id)
        await finish(id, downloadID: activeDownloadID, runtime: runtime)
    }

    private func consume(
        _ command: CoreCommand,
        downloadID: UInt64,
        runtime: DeviceRuntime,
        continuation: AsyncThrowingStream<FirmwareUpdateProgress, Error>.Continuation
    ) async {
        do {
            let notifications = await runtime.engine.run(command, capabilities: runtime.capabilities)
            for try await notification in notifications {
                switch notification.kind {
                case .firmwareProgress:
                    continuation.yield(try firmwareProgress(notification))
                case .failed:
                    throw workflowError(notification)
                case .cancelled:
                    throw facadeCancelled(operation: .updateFirmware)
                case .started, .deviceDiscovered, .connectionEstablished, .progress,
                     .retrying, .deviceUploadPreserved, .bleFallbackReady, .deviceLog,
                     .streamingPaused, .streamingResumed, .streamingCompleted, .completed:
                    break
                }
            }
            await finish(command.cancellationID, downloadID: downloadID, runtime: runtime)
            continuation.finish()
        } catch {
            await finish(command.cancellationID, downloadID: downloadID, runtime: runtime)
            continuation.finish(throwing: facadePublicError(error))
        }
    }

    private func finish(_ id: UUID, downloadID: UInt64?, runtime: DeviceRuntime) async {
        guard activeCancellationID == id else { return }
        if let downloadID { await runtime.unregisterFirmwareDownload(downloadID) }
        activeCancellationID = nil
        activeDownloadID = nil
        activeTask = nil
        await runtime.operations.end(id)
    }

    private func cancel(_ id: UUID, downloadID: UInt64) async {
        guard activeCancellationID == id, let runtime else { return }
        activeTask?.cancel()
        try? await runtime.engine.cancel(id)
        await finish(id, downloadID: downloadID, runtime: runtime)
    }
}

private func firmwareProgress(_ notification: CoreNotification) throws -> FirmwareUpdateProgress {
    let rawPhase = try unsigned(notification, UInt32(BOTA_DEVICE_SDK_V1_FIELD_FIRMWARE_PHASE))
    let phase: FirmwareUpdatePhase
    switch rawPhase {
    case 1: phase = .downloading
    case 2: phase = .awaitingDevice
    case 3: phase = .transferring
    case 4: phase = .verifying
    case 5: phase = .rebooting
    case 6: phase = .reconnecting
    case 7: phase = .complete
    default:
        throw BotaSDKError(
            code: .unknownPacket,
            operation: .updateFirmware,
            retryable: false,
            detail: "unknown firmware phase \(rawPhase)"
        )
    }
    return FirmwareUpdateProgress(
        phase: phase,
        completedBytes: try unsigned(notification, UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMPLETED_UNITS)),
        totalBytes: try unsigned(notification, UInt32(BOTA_DEVICE_SDK_V1_FIELD_TOTAL_UNITS))
    )
}
