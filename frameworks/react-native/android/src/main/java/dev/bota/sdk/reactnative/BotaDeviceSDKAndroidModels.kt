package dev.bota.sdk.reactnative

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.ConnectionState
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.DiscoveredDevice
import dev.bota.sdk.model.PairingState
import java.time.Instant

internal fun ReadableMap.toDiscoveredDevice(): DiscoveredDevice = DiscoveredDevice(
    id = getString("id") ?: error("selected device id is required"),
    name = optionalString("name"),
    deviceType = optionalString("deviceType")?.toDeviceType(),
    firmwareVersion = optionalString("firmwareVersion"),
    macAddress = optionalString("macAddress"),
    pairingState = optionalString("pairingState")?.toPairingState(),
    rssi = getDouble("rssi").toInt(),
    discoveredAt = Instant.ofEpochMilli(getDouble("discoveredAtMs").toLong()),
)

internal fun DiscoveredDevice.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putString("id", id)
    name?.let { putString("name", it) }
    deviceType?.let { putString("deviceType", it.toBridgeValue()) }
    firmwareVersion?.let { putString("firmwareVersion", it) }
    macAddress?.let { putString("macAddress", it) }
    pairingState?.let { putString("pairingState", it.toBridgeValue()) }
    putDouble("rssi", rssi.toDouble())
    putDouble("discoveredAtMs", discoveredAt.toEpochMilli().toDouble())
}

internal fun ConnectedDevice.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putString("id", id)
    putString("serialNumber", serialNumber)
    putString("deviceType", deviceType.toBridgeValue())
    putString("firmwareVersion", firmwareVersion)
    hardwareRevision?.let { putString("hardwareRevision", it) }
    putBoolean("isProvisioned", isProvisioned)
    putString("connectionState", connectionState.toBridgeValue())
    putInt("mtu", mtu)
}

private fun ReadableMap.optionalString(key: String): String? =
    if (hasKey(key) && !isNull(key)) getString(key) else null

private fun String.toDeviceType(): DeviceType? = when (this) {
    "bota_pin" -> DeviceType.BotaPin
    "bota_pin_4g" -> DeviceType.BotaPin4G
    "bota_note" -> DeviceType.BotaNote
    else -> null
}

private fun DeviceType.toBridgeValue(): String = when (this) {
    DeviceType.BotaPin -> "bota_pin"
    DeviceType.BotaPin4G -> "bota_pin_4g"
    DeviceType.BotaNote -> "bota_note"
    is DeviceType.Unknown -> "bota_pin"
}

private fun String.toPairingState(): PairingState? = when (this) {
    "unpaired" -> PairingState.Unpaired
    "pairing" -> PairingState.Pairing
    "paired" -> PairingState.Paired
    "error" -> PairingState.Error
    else -> null
}

internal fun PairingState.toBridgeValue(): String = when (this) {
    PairingState.Unpaired -> "unpaired"
    PairingState.Pairing -> "pairing"
    PairingState.Paired -> "paired"
    PairingState.Error -> "error"
    is PairingState.Unknown -> "unpaired"
}

private fun ConnectionState.toBridgeValue(): String = when (this) {
    ConnectionState.Disconnected -> "disconnected"
    ConnectionState.Connecting -> "connecting"
    ConnectionState.Bonding -> "bonding"
    ConnectionState.Discovering -> "discovering"
    ConnectionState.Connected -> "connected"
    ConnectionState.Disconnecting -> "disconnecting"
}
