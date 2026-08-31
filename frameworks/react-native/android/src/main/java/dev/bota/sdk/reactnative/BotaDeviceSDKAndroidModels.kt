package dev.bota.sdk.reactnative

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import dev.bota.sdk.UploadOwnershipResult
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.ConnectionState
import dev.bota.sdk.model.AudioCodec
import dev.bota.sdk.model.DeviceFlags
import dev.bota.sdk.model.DeviceLogLine
import dev.bota.sdk.model.DeviceConnectionSettings
import dev.bota.sdk.model.DeviceRecording
import dev.bota.sdk.model.DeviceState
import dev.bota.sdk.model.DeviceStatus
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.DiscoveredDevice
import dev.bota.sdk.model.FactoryResetCompletion
import dev.bota.sdk.model.FirmwareUpdatePhase
import dev.bota.sdk.model.FirmwareUpdateProgress
import dev.bota.sdk.model.LteStatus
import dev.bota.sdk.model.ModemInfo
import dev.bota.sdk.model.PairingState
import dev.bota.sdk.model.RecordingTransferProgress
import dev.bota.sdk.model.WifiRadioStatus
import dev.bota.sdk.model.WireValue
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

internal fun ReadableMap.toConnectedDevice(): ConnectedDevice = ConnectedDevice(
    id = getString("id") ?: error("connected device id is required"),
    serialNumber = getString("serialNumber") ?: error("connected device serial number is required"),
    deviceType = getString("deviceType")?.toDeviceType()
        ?: error("connected device type is required"),
    firmwareVersion = getString("firmwareVersion")
        ?: error("connected device firmware version is required"),
    hardwareRevision = optionalString("hardwareRevision"),
    isProvisioned = getBoolean("isProvisioned"),
    connectionState = getString("connectionState")?.toConnectionState()
        ?: error("connected device connection state is required"),
    mtu = requiredInt("mtu"),
)

internal fun ReadableMap.toDeviceRecording(): DeviceRecording = DeviceRecording(
    uuid = getString("uuid") ?: error("recording UUID is required"),
    startedAt = Instant.ofEpochMilli(requiredSafeUnsigned("startedAtMs").toLong()),
    durationMs = requiredSafeUnsigned("durationMs"),
    fileSizeBytes = requiredSafeUnsigned("fileSize"),
    codec = WireValue.Known(
        when (getString("codec")) {
            "pcm_16k" -> AudioCodec.Pcm16k
            "pcm_8k" -> AudioCodec.Pcm8k
            "opus_8k" -> AudioCodec.Opus8k
            else -> AudioCodec.Opus16k
        },
    ),
    isEncrypted = getBoolean("isEncrypted"),
)

internal fun ReadableMap.toDeviceConnectionSettings(): DeviceConnectionSettings {
    val enabled = getMap("enabledConnections") ?: error("enabled connections are required")
    val heartbeat = getMap("heartbeatEnabledConnections")
        ?: error("heartbeat enabled connections are required")
    val preference = getArray("uploadNetworkPreference")
        ?: error("upload network preference is required")
    val power = getMap("powerManagement") ?: error("power management is required")
    return DeviceConnectionSettings(
        enabledConnections = DeviceConnectionSettings.EnabledConnections(
            wifi = enabled.getBoolean("wifi"),
            cellular = enabled.getBoolean("cellular"),
        ),
        heartbeatEnabledConnections = DeviceConnectionSettings.EnabledConnections(
            wifi = heartbeat.getBoolean("wifi"),
            cellular = heartbeat.getBoolean("cellular"),
        ),
        uploadNetworkPreference = (0 until preference.size()).map { index ->
            when (preference.getString(index)) {
                "wifi" -> DeviceConnectionSettings.ConnectionType.Wifi
                "ble" -> DeviceConnectionSettings.ConnectionType.Ble
                "cellular" -> DeviceConnectionSettings.ConnectionType.Cellular
                else -> error("upload network preference contains an unsupported value")
            }
        },
        powerManagement = DeviceConnectionSettings.PowerManagement(
            wifiIdleTimeoutSeconds = power.requiredInt("wifiIdleTimeoutSeconds"),
            cellularIdleTimeoutSeconds = power.requiredInt("cellularIdleTimeoutSeconds"),
        ),
        streamingEnabled = getBoolean("streamingEnabled"),
        streamingFlushIntervalSeconds = requiredInt("streamingFlushIntervalSeconds"),
    )
}

internal fun DeviceConnectionSettings.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putMap("enabledConnections", Arguments.createMap().apply {
        putBoolean("wifi", enabledConnections.wifi)
        putBoolean("cellular", enabledConnections.cellular)
    })
    putMap("heartbeatEnabledConnections", Arguments.createMap().apply {
        putBoolean("wifi", heartbeatEnabledConnections.wifi)
        putBoolean("cellular", heartbeatEnabledConnections.cellular)
    })
    putArray("uploadNetworkPreference", Arguments.createArray().apply {
        uploadNetworkPreference.forEach { connection ->
            when (connection) {
                DeviceConnectionSettings.ConnectionType.Wifi -> pushString("wifi")
                DeviceConnectionSettings.ConnectionType.Ble -> pushString("ble")
                DeviceConnectionSettings.ConnectionType.Cellular -> pushString("cellular")
                is DeviceConnectionSettings.ConnectionType.Unknown -> Unit
            }
        }
    })
    putMap("powerManagement", Arguments.createMap().apply {
        putInt("wifiIdleTimeoutSeconds", powerManagement.wifiIdleTimeoutSeconds)
        putInt("cellularIdleTimeoutSeconds", powerManagement.cellularIdleTimeoutSeconds)
    })
    putBoolean("streamingEnabled", streamingEnabled)
    putInt("streamingFlushIntervalSeconds", streamingFlushIntervalSeconds)
}

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

internal fun DeviceRecording.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putString("uuid", uuid)
    putDouble("startedAtMs", startedAt.toEpochMilli().toDouble())
    putDouble("durationMs", durationMs.toDouble())
    putDouble("fileSize", fileSizeBytes.toDouble())
    putString("codec", codec.toAudioCodecBridgeValue())
    putBoolean("isEncrypted", isEncrypted)
}

internal fun RecordingTransferProgress.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putDouble("completedUnits", completedBytes.toDouble())
    putDouble("totalUnits", totalBytes.toDouble())
}

internal fun UploadOwnershipResult.toWritableMap(): WritableMap = Arguments.createMap().apply {
    when (this@toWritableMap) {
        UploadOwnershipResult.DeviceUploadCompleted -> {
            putString("kind", "device_upload_completed")
        }
        is UploadOwnershipResult.DeviceUploadPreserved -> {
            putString("kind", "device_upload_preserved")
            putString("uploadId", uploadId)
        }
        is UploadOwnershipResult.BluetoothFallback -> {
            putString("kind", "bluetooth_fallback")
            putString("recordingUuid", recordingUuid)
            putString("uploadId", uploadId)
            putString("destinationId", destinationId)
        }
    }
}

internal fun FirmwareUpdateProgress.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putString("phase", phase.toBridgeValue())
    putDouble("completedUnits", completedBytes.toDouble())
    putDouble("totalUnits", totalBytes.toDouble())
}

internal fun DeviceLogLine.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putString("message", message)
    putBoolean("isBacklog", isBacklog)
}

internal fun DeviceStatus.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putInt("batteryLevel", batteryLevel)
    batteryMv?.let { putInt("batteryMv", it) }
    putInt("storageTotalMb", storageTotalMb)
    putInt("storageUsedMb", storageUsedMb)
    putString("state", state.toDeviceStateBridgeValue())
    putInt("pendingRecordings", pendingRecordings)
    lastTimeSyncAt?.let { putDouble("lastTimeSyncAtMs", it.toEpochMilli().toDouble()) }
    putInt("signalStrength", signalStrength)
    putMap("flags", flags.toWritableMap())
    putDouble("timestamp", timestamp.toLong().toDouble())
    putString("lteStatus", lteStatus.toLteStatusBridgeValue())
    lteSignalQuality?.let { putInt("lteSignalQuality", it) }
    wifiStatus?.let { putString("wifiStatus", it.toWifiStatusBridgeValue()) }
    modemInfo?.let { putMap("modemInfo", it.toWritableMap()) }
}

internal fun BotaDeviceSDKAndroidProvisioningRequest.toWritableMap(): WritableMap =
    Arguments.createMap().apply {
        putString("requestId", requestId)
        putString("serialNumber", serialNumber)
        putString("nonce", nonce)
        putString("devicePublicKey", devicePublicKey)
    }

internal fun BotaDeviceSDKAndroidFactoryResetRequest.toWritableMap(): WritableMap =
    Arguments.createMap().apply {
        putString("requestId", requestId)
        putString("serialNumber", serialNumber)
        putString("nonce", nonce)
        putString("commandId", commandId)
        putDouble("bindingGeneration", bindingGeneration.toDouble())
    }

internal fun FactoryResetCompletion.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putString("commandId", commandId)
    putDouble("bindingGeneration", bindingGeneration.toDouble())
}

private fun DeviceFlags.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putBoolean("charging", charging)
    putBoolean("lowBattery", lowBattery)
    putBoolean("storageFull", storageFull)
    putBoolean("wifiConnected", wifiConnected)
    putBoolean("lteConnected", lteConnected)
    putBoolean("syncActive", syncActive)
}

private fun ModemInfo.toWritableMap(): WritableMap = Arguments.createMap().apply {
    imei?.let { putString("imei", it) }
    iccid?.let { putString("iccid", it) }
    operator?.let { putString("operator", it) }
    rat?.let { putString("rat", it) }
    band?.let { putString("band", it) }
    apn?.let { putString("apn", it) }
    simStatus?.let { putString("simStatus", it) }
    csq?.let { putInt("csq", it) }
    ipAddress?.let { putString("ipAddress", it) }
    modemVoltage?.let { putInt("modemVoltage", it) }
    modemFirmware?.let { putString("modemFirmware", it) }
    roaming?.let { putBoolean("roaming", it) }
}

private fun ReadableMap.optionalString(key: String): String? =
    if (hasKey(key) && !isNull(key)) getString(key) else null

private fun ReadableMap.requiredInt(key: String): Int {
    val value = getDouble(key)
    require(value.isFinite() && value % 1.0 == 0.0 && value in Int.MIN_VALUE.toDouble()..Int.MAX_VALUE.toDouble()) {
        "$key must be a finite integer"
    }
    return value.toInt()
}

private fun ReadableMap.requiredSafeUnsigned(key: String): ULong {
    val value = getDouble(key)
    require(value.isFinite() && value >= 0 && value <= 9_007_199_254_740_991.0 && value % 1.0 == 0.0) {
        "$key must be a finite non-negative integer"
    }
    return value.toLong().toULong()
}

private fun WireValue<AudioCodec>.toAudioCodecBridgeValue(): String = when (this) {
    is WireValue.Known -> when (value) {
        AudioCodec.Pcm16k -> "pcm_16k"
        AudioCodec.Pcm8k -> "pcm_8k"
        AudioCodec.Opus16k -> "opus_16k"
        AudioCodec.Opus8k -> "opus_8k"
    }
    is WireValue.Unknown -> "opus_16k"
}

private fun FirmwareUpdatePhase.toBridgeValue(): String = when (this) {
    FirmwareUpdatePhase.Downloading -> "downloading"
    FirmwareUpdatePhase.AwaitingDevice -> "awaiting_device"
    FirmwareUpdatePhase.Transferring -> "transferring"
    FirmwareUpdatePhase.Verifying -> "verifying"
    FirmwareUpdatePhase.Rebooting -> "rebooting"
    FirmwareUpdatePhase.Reconnecting -> "reconnecting"
    FirmwareUpdatePhase.Complete -> "complete"
}

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

private fun String.toConnectionState(): ConnectionState? = when (this) {
    "disconnected" -> ConnectionState.Disconnected
    "connecting" -> ConnectionState.Connecting
    "bonding" -> ConnectionState.Bonding
    "discovering" -> ConnectionState.Discovering
    "connected" -> ConnectionState.Connected
    "disconnecting" -> ConnectionState.Disconnecting
    else -> null
}

private fun WireValue<DeviceState>.toDeviceStateBridgeValue(): String = when (this) {
    is WireValue.Known -> when (value) {
        DeviceState.Idle -> "idle"
        DeviceState.Recording -> "recording"
        DeviceState.Syncing -> "syncing"
        DeviceState.Uploading -> "uploading"
        DeviceState.Charging -> "charging"
        DeviceState.LowBattery -> "lowBattery"
        DeviceState.StorageFull -> "storageFull"
        DeviceState.Error -> "error"
    }
    is WireValue.Unknown -> "idle"
}

private fun WireValue<LteStatus>.toLteStatusBridgeValue(): String = when (this) {
    is WireValue.Known -> when (value) {
        LteStatus.Off -> "off"
        LteStatus.Searching -> "searching"
        LteStatus.Registered -> "registered"
        LteStatus.Connected -> "connected"
        LteStatus.Denied -> "denied"
        LteStatus.NoSim -> "noSim"
        LteStatus.Error -> "error"
        LteStatus.LowVoltage -> "lowVoltage"
        LteStatus.Disabled -> "disabled"
    }
    is WireValue.Unknown -> "off"
}

private fun WireValue<WifiRadioStatus>.toWifiStatusBridgeValue(): String = when (this) {
    is WireValue.Known -> when (value) {
        WifiRadioStatus.Off -> "off"
        WifiRadioStatus.Scanning -> "scanning"
        WifiRadioStatus.Connecting -> "connecting"
        WifiRadioStatus.Connected -> "connected"
        WifiRadioStatus.ConnectFailed -> "connectFailed"
        WifiRadioStatus.NoCredentials -> "noCredentials"
        WifiRadioStatus.Disabled -> "disabled"
        WifiRadioStatus.Error -> "error"
    }
    is WireValue.Unknown -> "off"
}
