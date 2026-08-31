package dev.bota.sdk.internal

import dev.bota.sdk.BotaErrorCode
import dev.bota.sdk.BotaOperation
import dev.bota.sdk.BotaSDKError
import dev.bota.sdk.model.ConnectedDevice
import java.util.UUID

internal class DeviceConnectionRegistry {
    private val lock = Any()
    private var current: ConnectedDevice? = null

    fun set(device: ConnectedDevice) {
        synchronized(lock) { current = device }
    }

    fun clear() {
        synchronized(lock) { current = null }
    }

    fun require(device: ConnectedDevice) {
        val matches = synchronized(lock) {
            current?.id == device.id && current?.serialNumber == device.serialNumber
        }
        if (!matches) throw BotaSDKError.Core(
            BotaErrorCode.NotConnected,
            BotaOperation.Validate,
            retryable = true,
            protocolStatus = null,
            detail = "the device is not the current verified connection",
        )
    }
}

internal class DeviceOperationCoordinator {
    private val lock = Any()
    private var owner: UUID? = null

    fun begin(id: UUID, operation: BotaOperation) {
        synchronized(lock) {
            if (owner != null) throw BotaSDKError.Core(
                BotaErrorCode.OperationInProgress,
                operation,
                retryable = false,
                protocolStatus = null,
                detail = "another device operation is already active",
            )
            owner = id
        }
    }

    fun end(id: UUID) {
        synchronized(lock) { if (owner == id) owner = null }
    }
}
