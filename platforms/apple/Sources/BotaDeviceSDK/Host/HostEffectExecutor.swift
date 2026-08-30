import BotaDeviceSDKC
import Foundation

actor HostEffectExecutor: CoreHost {
    typealias ProgressHandler = @Sendable (UInt64, UInt64) async -> Void

    private let bluetooth: any BluetoothHost
    private let persistence: any PersistenceHost
    private let network: any NetworkHost
    private let material: any MaterialHost
    private let recordingSink: any RecordingSinkHost
    private let firmwareBlob: any FirmwareBlobHost
    private let progress: ProgressHandler
    private var tasks: [CoreCancellationID: [UInt64: Task<Void, Never>]] = [:]
    private var timers: [UInt64: (cancellationID: CoreCancellationID, requestID: UInt64)] = [:]

    init(
        bluetooth: any BluetoothHost,
        persistence: any PersistenceHost,
        network: any NetworkHost,
        material: any MaterialHost,
        recordingSink: any RecordingSinkHost,
        firmwareBlob: any FirmwareBlobHost,
        progress: @escaping ProgressHandler = { _, _ in }
    ) {
        self.bluetooth = bluetooth
        self.persistence = persistence
        self.network = network
        self.material = material
        self.recordingSink = recordingSink
        self.firmwareBlob = firmwareBlob
        self.progress = progress
    }

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEvent, Error> {
        switch effect {
        case .timerSchedule:
            return scheduleTimer(effect)
        case .timerCancel:
            return cancelTimer(effect)
        case .persistenceLoadCheckpoint, .persistenceSaveCheckpoint, .persistenceDeleteCheckpoint,
             .persistenceSaveConnectionIdentity, .persistenceSaveFactoryResetResult,
             .persistenceDeleteFactoryResetResult, .secureStorageRead, .secureStorageWrite,
             .secureStorageDelete:
            return route(
                await persistence.execute(effect),
                effect: effect,
                failureKind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_PERSISTENCE_FAILED)
            )
        case .bluetoothStartScan, .bluetoothStopScan, .bluetoothConnect,
             .bluetoothDiscoverServices, .bluetoothDisconnect, .bluetoothRead,
             .bluetoothWrite, .bluetoothSubscribe, .bluetoothUnsubscribe:
            return route(
                await bluetooth.execute(effect),
                effect: effect,
                failureKind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_FAILED)
            )
        case .networkDownload, .networkUpload:
            return route(
                await network.execute(effect),
                effect: effect,
                failureKind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_NETWORK_FAILED)
            )
        case .progress:
            return reportProgress(effect)
        case .prepareProvisioning, .prepareFactoryResetGrant:
            return route(
                await material.execute(effect),
                effect: effect,
                failureKind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_HOST_MATERIAL_FAILED)
            )
        case .recordingSinkTruncate, .recordingSinkAppend, .recordingSinkFinalize,
             .recordingSinkDiscard:
            return route(
                await recordingSink.execute(effect),
                effect: effect,
                failureKind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_RECORDING_SINK_FAILED)
            )
        case .firmwareBlobRead:
            return route(
                await firmwareBlob.execute(effect),
                effect: effect,
                failureKind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_FIRMWARE_BLOB_FAILED)
            )
        }
    }

    func cancel(_ cancellationID: CoreCancellationID) async {
        let ownedTasks = tasks.removeValue(forKey: cancellationID)?.values ?? [:].values
        for task in ownedTasks { task.cancel() }
        timers = timers.filter { $0.value.cancellationID != cancellationID }
    }

    private func route(
        _ upstream: AsyncThrowingStream<CoreHostEventPayload, Error>,
        effect: CoreEffect,
        failureKind: UInt32
    ) -> AsyncThrowingStream<CoreHostEvent, Error> {
        let pair = AsyncThrowingStream<CoreHostEvent, Error>.makeStream()
        let task = Task {
            do {
                var eventCount = 0
                for try await payload in upstream {
                    try Task.checkCancellation()
                    eventCount += 1
                    guard expectedEventKinds(for: effect).contains(payload.kind),
                          allowsMultipleEvents(effect) || eventCount == 1
                    else {
                        throw invalidEffect(effect, "host returned an event that does not match the effect")
                    }
                    pair.continuation.yield(CoreHostEvent(effect: effect, payload: payload))
                }
                pair.continuation.finish()
            } catch is CancellationError {
                pair.continuation.finish()
            } catch {
                pair.continuation.yield(failureEvent(effect: effect, kind: failureKind, error: error))
                pair.continuation.finish()
            }
            removeTask(effect)
        }
        register(task, for: effect)
        pair.continuation.onTermination = { @Sendable _ in task.cancel() }
        return pair.stream
    }

    private func scheduleTimer(_ effect: CoreEffect) -> AsyncThrowingStream<CoreHostEvent, Error> {
        guard let timerID = effect.packet.fields.unsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_TIMER_ID)),
              let delay = effect.packet.fields.unsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_DELAY_MS))
        else {
            return failedStream(invalidEffect(effect, "timer schedule fields are missing"))
        }

        let pair = AsyncThrowingStream<CoreHostEvent, Error>.makeStream()
        let task = Task {
            do {
                let nanoseconds = delay.multipliedReportingOverflow(by: 1_000_000)
                try await Task.sleep(nanoseconds: nanoseconds.overflow ? UInt64.max : nanoseconds.partialValue)
                try Task.checkCancellation()
                pair.continuation.yield(CoreHostEvent(
                    effect: effect,
                    kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_TIMER_FIRED),
                    fields: [.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TIMER_ID), value: timerID)]
                ))
                pair.continuation.finish()
            } catch {
                pair.continuation.finish()
            }
            removeTimer(timerID, effect: effect)
        }
        timers[timerID] = (effect.cancellationID, effect.requestID)
        register(task, for: effect)
        pair.continuation.onTermination = { @Sendable _ in task.cancel() }
        return pair.stream
    }

    private func cancelTimer(_ effect: CoreEffect) -> AsyncThrowingStream<CoreHostEvent, Error> {
        guard let timerID = effect.packet.fields.unsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_TIMER_ID)) else {
            return failedStream(invalidEffect(effect, "timer cancellation ID is missing"))
        }
        if let owner = timers.removeValue(forKey: timerID) {
            tasks[owner.cancellationID]?[owner.requestID]?.cancel()
            tasks[owner.cancellationID]?[owner.requestID] = nil
        }
        return emptyStream()
    }

    private func reportProgress(_ effect: CoreEffect) -> AsyncThrowingStream<CoreHostEvent, Error> {
        guard let completed = effect.packet.fields.unsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMPLETED_UNITS)),
              let total = effect.packet.fields.unsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_TOTAL_UNITS))
        else {
            return failedStream(invalidEffect(effect, "progress fields are missing"))
        }
        let pair = AsyncThrowingStream<CoreHostEvent, Error>.makeStream()
        Task {
            await progress(completed, total)
            pair.continuation.finish()
        }
        return pair.stream
    }

    private func failureEvent(effect: CoreEffect, kind: UInt32, error: Error) -> CoreHostEvent {
        let platformCode = Int64((error as NSError).code)
        var fields: [CoreField] = []
        if kind == UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_NETWORK_FAILED) {
            let transferID = effect.packet.fields.unsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_DOWNLOAD_ID))
                ?? effect.packet.fields.unsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_UPLOAD_ID))
                ?? 0
            fields.append(.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TRANSFER_ID), value: transferID))
            if case let NativeHostError.httpStatus(status) = error {
                fields.append(.unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_STATUS_CODE), value: UInt64(status)))
            }
        } else {
            fields.append(.signed(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_PLATFORM_CODE), value: platformCode))
        }
        return CoreHostEvent(effect: effect, kind: kind, fields: fields)
    }

    private func expectedEventKinds(for effect: CoreEffect) -> Set<UInt32> {
        switch effect {
        case .timerSchedule:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_TIMER_FIRED)]
        case .timerCancel, .progress, .bluetoothUnsubscribe, .recordingSinkDiscard:
            return []
        case .persistenceLoadCheckpoint:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_CHECKPOINT_LOADED)]
        case .persistenceSaveCheckpoint, .persistenceDeleteCheckpoint:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_CHECKPOINT_SAVED)]
        case .persistenceSaveConnectionIdentity:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_CONNECTION_IDENTITY_SAVED)]
        case .persistenceSaveFactoryResetResult:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_FACTORY_RESET_RESULT_SAVED)]
        case .persistenceDeleteFactoryResetResult:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_FACTORY_RESET_RESULT_DELETED)]
        case .secureStorageRead:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_SECRET_LOADED)]
        case .secureStorageWrite, .secureStorageDelete:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_SECRET_STORED)]
        case .bluetoothStartScan:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_SCAN_RESULT)]
        case .bluetoothStopScan:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_SCAN_STOPPED)]
        case .bluetoothConnect:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_CONNECTED)]
        case .bluetoothDiscoverServices:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_SERVICES_DISCOVERED)]
        case .bluetoothDisconnect:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_DISCONNECTED)]
        case .bluetoothRead:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_READ_COMPLETED)]
        case .bluetoothWrite:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_WRITE_COMPLETED)]
        case .bluetoothSubscribe:
            return [
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_SUBSCRIBED),
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_NOTIFICATION),
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_BLE_DISCONNECTED),
            ]
        case .networkDownload:
            return [
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_NETWORK_DOWNLOAD_PROGRESS),
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_NETWORK_DOWNLOAD_COMPLETED),
            ]
        case .networkUpload:
            return [
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_NETWORK_UPLOAD_PROGRESS),
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_NETWORK_UPLOAD_COMPLETED),
            ]
        case .prepareProvisioning:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_PROVISIONING_MATERIAL_PREPARED)]
        case .prepareFactoryResetGrant:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_FACTORY_RESET_GRANT_PREPARED)]
        case .recordingSinkTruncate:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_RECORDING_SINK_TRUNCATED)]
        case .recordingSinkAppend:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_RECORDING_SINK_APPEND_COMPLETED)]
        case .recordingSinkFinalize:
            return [
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_RECORDING_SINK_FINALIZED),
                UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_RECORDING_SINK_INTEGRITY_FAILED),
            ]
        case .firmwareBlobRead:
            return [UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_FIRMWARE_CHUNK_READ)]
        }
    }

    private func allowsMultipleEvents(_ effect: CoreEffect) -> Bool {
        switch effect {
        case .bluetoothStartScan, .bluetoothSubscribe, .networkDownload, .networkUpload:
            return true
        case .timerSchedule, .timerCancel, .persistenceLoadCheckpoint,
             .persistenceSaveCheckpoint, .persistenceDeleteCheckpoint,
             .persistenceSaveConnectionIdentity, .persistenceSaveFactoryResetResult,
             .persistenceDeleteFactoryResetResult, .secureStorageRead, .secureStorageWrite,
             .secureStorageDelete, .bluetoothStopScan, .bluetoothConnect,
             .bluetoothDiscoverServices, .bluetoothDisconnect, .bluetoothRead,
             .bluetoothWrite, .bluetoothUnsubscribe, .progress, .prepareProvisioning,
             .prepareFactoryResetGrant, .recordingSinkTruncate, .recordingSinkAppend,
             .recordingSinkFinalize, .recordingSinkDiscard, .firmwareBlobRead:
            return false
        }
    }

    private func register(_ task: Task<Void, Never>, for effect: CoreEffect) {
        tasks[effect.cancellationID, default: [:]][effect.requestID] = task
    }

    private func removeTask(_ effect: CoreEffect) {
        tasks[effect.cancellationID]?[effect.requestID] = nil
        if tasks[effect.cancellationID]?.isEmpty == true { tasks[effect.cancellationID] = nil }
    }

    private func removeTimer(_ timerID: UInt64, effect: CoreEffect) {
        if timers[timerID]?.requestID == effect.requestID { timers[timerID] = nil }
        removeTask(effect)
    }

    private func emptyStream() -> AsyncThrowingStream<CoreHostEvent, Error> {
        AsyncThrowingStream { $0.finish() }
    }

    private func failedStream(_ error: Error) -> AsyncThrowingStream<CoreHostEvent, Error> {
        AsyncThrowingStream { $0.finish(throwing: error) }
    }

    private func invalidEffect(_ effect: CoreEffect, _ detail: String) -> CoreError {
        CoreError(
            code: UInt32(BOTA_DEVICE_SDK_V1_ERROR_INVALID_INPUT),
            operation: effect.operation,
            retryable: false,
            protocolStatus: nil,
            detail: detail
        )
    }
}
