package dev.bota.sdk.internal.bluetooth

import dev.bota.sdk.BotaOperation
import dev.bota.sdk.BotaSDKError

internal class BluetoothPermissionChecker(
    private val apiLevel: Int,
    private val isGranted: (String) -> Boolean,
) {
    val requiredPermissions: Set<String>
        get() = if (apiLevel >= 31) setOf(BluetoothScan, BluetoothConnect) else setOf(FineLocation)

    fun requireScan(operation: BotaOperation) = require(requiredPermissions, operation)

    fun requireConnect(operation: BotaOperation) = require(requiredPermissions, operation)

    private fun require(permissions: Set<String>, operation: BotaOperation) {
        val missing = permissions.filterNot(isGranted).toSet()
        if (missing.isNotEmpty()) throw BotaSDKError.AuthorizationRequired(missing, operation)
    }

    companion object {
        const val FineLocation: String = "android.permission.ACCESS_FINE_LOCATION"
        const val BluetoothScan: String = "android.permission.BLUETOOTH_SCAN"
        const val BluetoothConnect: String = "android.permission.BLUETOOTH_CONNECT"
    }
}
