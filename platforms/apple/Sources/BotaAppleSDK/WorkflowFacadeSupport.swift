import BotaDeviceSDKC

func awaitWorkflowCompletion(_ command: CoreCommand, runtime: DeviceRuntime) async throws {
    var completed = false
    do {
        let notifications = await runtime.engine.run(command, capabilities: runtime.capabilities)
        for try await notification in notifications {
            switch notification.kind {
            case .completed:
                completed = true
            case .cancelled:
                throw BotaSDKError(
                    code: .cancelled,
                    operation: BotaSDKError.operation(notification.packet.operation),
                    retryable: true,
                    detail: "device workflow was cancelled"
                )
            case .failed:
                throw workflowError(notification)
            case .started, .deviceDiscovered, .connectionEstablished, .progress,
                 .retrying, .deviceUploadPreserved, .bleFallbackReady,
                 .firmwareProgress, .deviceLog, .streamingPaused, .streamingResumed,
                 .streamingCompleted, .encryptedUploadV2Staged:
                break
            }
        }
    } catch let error as BotaSDKError {
        throw error
    } catch let error as CoreError {
        throw BotaSDKError(error)
    }
    guard completed else {
        throw BotaSDKError(
            code: .internal,
            operation: BotaSDKError.operation(command.kind),
            retryable: true,
            detail: "device workflow ended without a terminal completion"
        )
    }
}

func workflowError(_ notification: CoreNotification) -> BotaSDKError {
    let fields = notification.packet.fields
    let rawCode = fields.facadeUnsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_ERROR_CODE)) ?? 21
    return BotaSDKError(
        code: BotaSDKError.code(UInt32(clamping: rawCode)),
        operation: BotaSDKError.operation(notification.packet.operation),
        retryable: fields.facadeBool(UInt32(BOTA_DEVICE_SDK_V1_FIELD_RETRYABLE)) ?? false,
        protocolStatus: fields
            .facadeUnsigned(UInt32(BOTA_DEVICE_SDK_V1_FIELD_PROTOCOL_STATUS))
            .flatMap { UInt16(exactly: $0) },
        detail: fields.facadeText(UInt32(BOTA_DEVICE_SDK_V1_FIELD_ERROR_DETAIL))
            ?? "device workflow failed"
    )
}

private extension Array where Element == CoreField {
    func facadeUnsigned(_ id: UInt32) -> UInt64? {
        for field in self {
            if case let .unsigned(fieldID, value) = field, fieldID == id { return value }
        }
        return nil
    }

    func facadeBool(_ id: UInt32) -> Bool? {
        for field in self {
            if case let .bool(fieldID, value) = field, fieldID == id { return value }
        }
        return nil
    }

    func facadeText(_ id: UInt32) -> String? {
        for field in self {
            if case let .text(fieldID, value) = field, fieldID == id { return value }
        }
        return nil
    }
}
