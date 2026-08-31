@file:Suppress("DEPRECATION")

package com.bota.sdk

import java.net.URL
import java.time.Instant

@Deprecated("Use dev.bota.sdk.model.DeviceType", ReplaceWith("DeviceType", "dev.bota.sdk.model.DeviceType"))
public enum class DeviceType { BOTA_PIN, BOTA_PIN_4G, BOTA_NOTE }

@Deprecated("Use dev.bota.sdk.model.PairingState", ReplaceWith("PairingState", "dev.bota.sdk.model.PairingState"))
public enum class PairingState { UNPAIRED, PAIRING, PAIRED, ERROR }

@Deprecated("Use dev.bota.sdk.model.ConnectionState", ReplaceWith("ConnectionState", "dev.bota.sdk.model.ConnectionState"))
public enum class ConnectionState { DISCONNECTED, CONNECTING, BONDING, DISCOVERING, CONNECTED, DISCONNECTING }

@Deprecated("Use dev.bota.sdk.model.DeviceState", ReplaceWith("DeviceState", "dev.bota.sdk.model.DeviceState"))
public enum class DeviceState { IDLE, RECORDING, SYNCING, UPLOADING, CHARGING, LOW_BATTERY, STORAGE_FULL, ERROR }

@Deprecated("Use dev.bota.sdk.model.LteStatus", ReplaceWith("LteStatus", "dev.bota.sdk.model.LteStatus"))
public enum class LteStatus { OFF, SEARCHING, REGISTERED, CONNECTED, DENIED, NO_SIM, ERROR, LOW_VOLTAGE, DISABLED }

@Deprecated("Use dev.bota.sdk.model.WifiRadioStatus", ReplaceWith("WifiRadioStatus", "dev.bota.sdk.model.WifiRadioStatus"))
public enum class WifiRadioStatus { OFF, SCANNING, CONNECTING, CONNECTED, CONNECT_FAILED, NO_CREDENTIALS, DISABLED, ERROR }

@Deprecated("Use dev.bota.sdk.model.AudioCodec", ReplaceWith("AudioCodec", "dev.bota.sdk.model.AudioCodec"))
public enum class AudioCodec { PCM_16K, PCM_8K, OPUS_16K, OPUS_8K }

@Deprecated("Use dev.bota.sdk.model.TransferPacketType", ReplaceWith("TransferPacketType", "dev.bota.sdk.model.TransferPacketType"))
public enum class TransferPacketType { DATA, EOF, PAUSED, SHA256, E2E_START, ENCRYPTED_DATA, ENCRYPTED_EOF, ERROR }

@Deprecated(
    "Use dev.bota.sdk.model.DeviceConnectionSettings.ConnectionType",
    ReplaceWith("DeviceConnectionSettings.ConnectionType", "dev.bota.sdk.model.DeviceConnectionSettings"),
)
public enum class ConnectionType { WIFI, BLE, CELLULAR }

@Deprecated("Use dev.bota.sdk.model.DeviceFlags", ReplaceWith("DeviceFlags", "dev.bota.sdk.model.DeviceFlags"))
public data class DeviceFlags(
    public val charging: Boolean,
    public val lowBattery: Boolean,
    public val storageFull: Boolean,
    public val wifiConnected: Boolean,
    public val lteConnected: Boolean,
    public val syncActive: Boolean,
)

@Deprecated("Use dev.bota.sdk.model.ModemInfo", ReplaceWith("ModemInfo", "dev.bota.sdk.model.ModemInfo"))
public data class ModemInfo(
    public val imei: String? = null,
    public val iccid: String? = null,
    public val operator: String? = null,
    public val rat: String? = null,
    public val band: String? = null,
    public val apn: String? = null,
    public val simStatus: String? = null,
    public val csq: Int? = null,
    public val ipAddress: String? = null,
    public val modemVoltage: Int? = null,
    public val modemFirmware: String? = null,
    public val roaming: Boolean? = null,
)

@Deprecated("Use dev.bota.sdk.model.DeviceStatus", ReplaceWith("DeviceStatus", "dev.bota.sdk.model.DeviceStatus"))
public data class DeviceStatus(
    public val batteryLevel: Int,
    public val batteryMv: Int?,
    public val storageTotalMb: Int,
    public val storageUsedMb: Int,
    public val state: DeviceState,
    public val pendingRecordings: Int,
    public val lastTimeSyncAt: Instant?,
    public val flags: DeviceFlags,
    public val timestamp: Long,
    public val lteStatus: LteStatus,
    public val lteSignalQuality: Int?,
    public val wifiStatus: WifiRadioStatus?,
    public val modemInfo: ModemInfo?,
)

@Deprecated("Use dev.bota.sdk.model.DeviceRecording", ReplaceWith("DeviceRecording", "dev.bota.sdk.model.DeviceRecording"))
public data class DeviceRecording(
    public val uuid: String,
    public val startedAt: Instant,
    public val durationMs: Int,
    public val fileSizeBytes: Int,
    public val codec: AudioCodec,
    public val isEncrypted: Boolean? = null,
)

@Deprecated("Raw transfer packets are owned by the Rust core", ReplaceWith("RecordingSyncEvent", "dev.bota.sdk.RecordingSyncEvent"))
public data class TransferPacket(
    public val type: TransferPacketType,
    public val sequenceNumber: Int,
    public val data: ByteArray? = null,
    public val checksum: Int? = null,
    public val bytesSent: Int? = null,
    public val errorCode: Int? = null,
    public val e2eEphemeralPublicKey: ByteArray? = null,
    public val e2eSalt: ByteArray? = null,
    public val e2eChunk: ByteArray? = null,
    public val sha256: ByteArray? = null,
)

@Deprecated(
    "Use dev.bota.sdk.model.DeviceConnectionSettings.EnabledConnections",
    ReplaceWith("DeviceConnectionSettings.EnabledConnections", "dev.bota.sdk.model.DeviceConnectionSettings"),
)
public data class EnabledConnections(public val wifi: Boolean, public val cellular: Boolean)

@Deprecated(
    "Use dev.bota.sdk.model.DeviceConnectionSettings.PowerManagement",
    ReplaceWith("DeviceConnectionSettings.PowerManagement", "dev.bota.sdk.model.DeviceConnectionSettings"),
)
public data class PowerManagement(public val wifiIdleTimeoutSeconds: Int, public val cellularIdleTimeoutSeconds: Int)

@Deprecated(
    "Use dev.bota.sdk.model.DeviceConnectionSettings",
    ReplaceWith("DeviceConnectionSettings", "dev.bota.sdk.model.DeviceConnectionSettings"),
)
public data class DeviceConnectionSettings(
    public val enabledConnections: EnabledConnections,
    public val uploadNetworkPreference: List<ConnectionType>,
    public val powerManagement: PowerManagement? = null,
    public val streamingEnabled: Boolean? = null,
    public val streamingFlushIntervalSeconds: Int? = null,
)

@Deprecated("Use dev.bota.sdk.model.DiscoveredDevice", ReplaceWith("DiscoveredDevice", "dev.bota.sdk.model.DiscoveredDevice"))
public data class DiscoveredDevice(
    public val id: String,
    public val name: String,
    public val deviceType: DeviceType,
    public val firmwareVersion: String,
    public val macAddress: String?,
    public val pairingState: PairingState,
    public val rssi: Int,
    public val manufacturerData: ByteArray? = null,
    public val discoveredAt: Instant,
)

@Deprecated("Use dev.bota.sdk.model.ConnectedDevice", ReplaceWith("ConnectedDevice", "dev.bota.sdk.model.ConnectedDevice"))
public data class ConnectedDevice(
    public val id: String,
    public val serialNumber: String,
    public val deviceType: DeviceType,
    public val firmwareVersion: String,
    public val hardwareRevision: String? = null,
    public val isProvisioned: Boolean,
    public val connectionState: ConnectionState,
    public val mtu: Int,
)

@Deprecated("Use application-authorized upload ownership", ReplaceWith("UploadOwnershipEvent", "dev.bota.sdk.UploadOwnershipEvent"))
public data class UploadInfo(
    public val uploadUrl: URL,
    public val recordingId: String,
    public val uploadToken: String? = null,
    public val completeUrl: URL? = null,
    public val contentType: String? = null,
)

@Deprecated("Use dev.bota.sdk.RecordingSyncEvent", ReplaceWith("RecordingSyncEvent", "dev.bota.sdk.RecordingSyncEvent"))
public enum class SyncStage { PREPARING, TRANSFERRING, UPLOADING, DEVICE_UPLOADING, COMPLETING, COMPLETED, FAILED }

@Deprecated("Use dev.bota.sdk.RecordingSyncEvent", ReplaceWith("RecordingSyncEvent", "dev.bota.sdk.RecordingSyncEvent"))
public data class SyncProgress(
    public val stage: SyncStage,
    public val progress: Double,
    public val bytesTransferred: Int? = null,
    public val totalBytes: Int? = null,
    public val bytesUploaded: Int? = null,
    public val recordingId: String? = null,
    public val error: String? = null,
    public val contentSha256: String? = null,
)

internal fun dev.bota.sdk.model.DeviceType.toLegacy(): DeviceType = when (this) {
    dev.bota.sdk.model.DeviceType.BotaPin -> DeviceType.BOTA_PIN
    dev.bota.sdk.model.DeviceType.BotaPin4G -> DeviceType.BOTA_PIN_4G
    dev.bota.sdk.model.DeviceType.BotaNote -> DeviceType.BOTA_NOTE
    is dev.bota.sdk.model.DeviceType.Unknown -> throw BotaSdkException.UnsupportedOperation("Unknown device type: $rawValue")
}

internal fun DeviceType.toNative(): dev.bota.sdk.model.DeviceType = when (this) {
    DeviceType.BOTA_PIN -> dev.bota.sdk.model.DeviceType.BotaPin
    DeviceType.BOTA_PIN_4G -> dev.bota.sdk.model.DeviceType.BotaPin4G
    DeviceType.BOTA_NOTE -> dev.bota.sdk.model.DeviceType.BotaNote
}

internal fun dev.bota.sdk.model.PairingState?.toLegacy(): PairingState = when (this) {
    dev.bota.sdk.model.PairingState.Unpaired -> PairingState.UNPAIRED
    dev.bota.sdk.model.PairingState.Pairing -> PairingState.PAIRING
    dev.bota.sdk.model.PairingState.Paired -> PairingState.PAIRED
    dev.bota.sdk.model.PairingState.Error, is dev.bota.sdk.model.PairingState.Unknown, null -> PairingState.ERROR
}

internal fun dev.bota.sdk.model.DiscoveredDevice.toLegacy(): DiscoveredDevice = DiscoveredDevice(
    id = id,
    name = name.orEmpty(),
    deviceType = deviceType?.toLegacy() ?: DeviceType.BOTA_PIN,
    firmwareVersion = firmwareVersion.orEmpty(),
    macAddress = macAddress,
    pairingState = pairingState.toLegacy(),
    rssi = rssi,
    manufacturerData = manufacturerData,
    discoveredAt = discoveredAt,
)

internal fun DiscoveredDevice.toNative(): dev.bota.sdk.model.DiscoveredDevice = dev.bota.sdk.model.DiscoveredDevice(
    id = id,
    name = name,
    deviceType = deviceType.toNative(),
    firmwareVersion = firmwareVersion,
    macAddress = macAddress,
    pairingState = when (pairingState) {
        PairingState.UNPAIRED -> dev.bota.sdk.model.PairingState.Unpaired
        PairingState.PAIRING -> dev.bota.sdk.model.PairingState.Pairing
        PairingState.PAIRED -> dev.bota.sdk.model.PairingState.Paired
        PairingState.ERROR -> dev.bota.sdk.model.PairingState.Error
    },
    rssi = rssi,
    manufacturerData = manufacturerData,
    discoveredAt = discoveredAt,
)

internal fun dev.bota.sdk.model.ConnectedDevice.toLegacy(): ConnectedDevice = ConnectedDevice(
    id = id,
    serialNumber = serialNumber,
    deviceType = deviceType.toLegacy(),
    firmwareVersion = firmwareVersion,
    hardwareRevision = hardwareRevision,
    isProvisioned = isProvisioned,
    connectionState = connectionState.toLegacy(),
    mtu = mtu,
)

internal fun ConnectedDevice.toNative(): dev.bota.sdk.model.ConnectedDevice = dev.bota.sdk.model.ConnectedDevice(
    id = id,
    serialNumber = serialNumber,
    deviceType = deviceType.toNative(),
    firmwareVersion = firmwareVersion,
    hardwareRevision = hardwareRevision,
    isProvisioned = isProvisioned,
    connectionState = connectionState.toNative(),
    mtu = mtu,
)

private fun dev.bota.sdk.model.ConnectionState.toLegacy(): ConnectionState = ConnectionState.entries[ordinal]
private fun ConnectionState.toNative(): dev.bota.sdk.model.ConnectionState = dev.bota.sdk.model.ConnectionState.entries[ordinal]

internal fun dev.bota.sdk.model.DeviceRecording.toLegacy(): DeviceRecording = DeviceRecording(
    uuid = uuid,
    startedAt = startedAt,
    durationMs = durationMs.toInt(),
    fileSizeBytes = fileSizeBytes.toInt(),
    codec = when (val value = codec) {
        is dev.bota.sdk.model.WireValue.Known -> AudioCodec.entries[value.value.ordinal]
        is dev.bota.sdk.model.WireValue.Unknown -> throw BotaSdkException.UnsupportedOperation("Unknown audio codec: ${value.rawValue}")
    },
    isEncrypted = isEncrypted,
)

internal fun DeviceRecording.toNative(): dev.bota.sdk.model.DeviceRecording = dev.bota.sdk.model.DeviceRecording(
    uuid = uuid,
    startedAt = startedAt,
    durationMs = durationMs.toULong(),
    fileSizeBytes = fileSizeBytes.toULong(),
    codec = dev.bota.sdk.model.WireValue.Known(dev.bota.sdk.model.AudioCodec.entries[codec.ordinal]),
    isEncrypted = isEncrypted ?: false,
)

internal fun dev.bota.sdk.model.DeviceStatus.toLegacy(): DeviceStatus = DeviceStatus(
    batteryLevel = batteryLevel,
    batteryMv = batteryMv,
    storageTotalMb = storageTotalMb,
    storageUsedMb = storageUsedMb,
    state = state.legacyOr(DeviceState.ERROR) { DeviceState.entries[it.ordinal] },
    pendingRecordings = pendingRecordings,
    lastTimeSyncAt = lastTimeSyncAt,
    flags = DeviceFlags(flags.charging, flags.lowBattery, flags.storageFull, flags.wifiConnected, flags.lteConnected, flags.syncActive),
    timestamp = timestamp.toLong(),
    lteStatus = lteStatus.legacyOr(LteStatus.ERROR) { LteStatus.entries[it.ordinal] },
    lteSignalQuality = lteSignalQuality,
    wifiStatus = wifiStatus?.legacyOr(WifiRadioStatus.ERROR) { WifiRadioStatus.entries[it.ordinal] },
    modemInfo = modemInfo?.let {
        ModemInfo(it.imei, it.iccid, it.operator, it.rat, it.band, it.apn, it.simStatus, it.csq, it.ipAddress, it.modemVoltage, it.modemFirmware, it.roaming)
    },
)

private fun <T, R> dev.bota.sdk.model.WireValue<T>.legacyOr(fallback: R, transform: (T) -> R): R = when (this) {
    is dev.bota.sdk.model.WireValue.Known -> transform(value)
    is dev.bota.sdk.model.WireValue.Unknown -> fallback
}

internal fun DeviceConnectionSettings.toNative(): dev.bota.sdk.model.DeviceConnectionSettings =
    dev.bota.sdk.model.DeviceConnectionSettings(
        enabledConnections = dev.bota.sdk.model.DeviceConnectionSettings.EnabledConnections(
            enabledConnections.wifi,
            enabledConnections.cellular,
        ),
        uploadNetworkPreference = uploadNetworkPreference.map {
            when (it) {
                ConnectionType.WIFI -> dev.bota.sdk.model.DeviceConnectionSettings.ConnectionType.Wifi
                ConnectionType.BLE -> dev.bota.sdk.model.DeviceConnectionSettings.ConnectionType.Ble
                ConnectionType.CELLULAR -> dev.bota.sdk.model.DeviceConnectionSettings.ConnectionType.Cellular
            }
        },
        powerManagement = powerManagement?.let {
            dev.bota.sdk.model.DeviceConnectionSettings.PowerManagement(
                it.wifiIdleTimeoutSeconds,
                it.cellularIdleTimeoutSeconds,
            )
        } ?: dev.bota.sdk.model.DeviceConnectionSettings.PowerManagement(),
        streamingEnabled = streamingEnabled ?: true,
        streamingFlushIntervalSeconds = streamingFlushIntervalSeconds ?: 60,
    )
