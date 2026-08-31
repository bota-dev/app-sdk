package dev.bota.sdk.model

import java.time.Instant

public sealed interface WireValue<out T> {
    public val unknownRawValue: ULong?

    public data class Known<T>(public val value: T) : WireValue<T> {
        override val unknownRawValue: ULong? = null
    }

    public data class Unknown(public val rawValue: ULong) : WireValue<Nothing> {
        override val unknownRawValue: ULong = rawValue
    }
}

public sealed interface DeviceType {
    public data object BotaPin : DeviceType
    public data object BotaPin4G : DeviceType
    public data object BotaNote : DeviceType
    public data class Unknown(public val rawValue: UByte) : DeviceType
}

public sealed interface PairingState {
    public data object Unpaired : PairingState
    public data object Pairing : PairingState
    public data object Paired : PairingState
    public data object Error : PairingState
    public data class Unknown(public val rawValue: UByte) : PairingState
}

public enum class ConnectionState {
    Disconnected,
    Connecting,
    Bonding,
    Discovering,
    Connected,
    Disconnecting,
}

public enum class DeviceState {
    Idle,
    Recording,
    Syncing,
    Uploading,
    Charging,
    LowBattery,
    StorageFull,
    Error,
}

public enum class LteStatus {
    Off,
    Searching,
    Registered,
    Connected,
    Denied,
    NoSim,
    Error,
    LowVoltage,
    Disabled,
}

public enum class WifiRadioStatus {
    Off,
    Scanning,
    Connecting,
    Connected,
    ConnectFailed,
    NoCredentials,
    Disabled,
    Error,
}

public data class DeviceFlags(
    public val charging: Boolean,
    public val lowBattery: Boolean,
    public val storageFull: Boolean,
    public val wifiConnected: Boolean,
    public val lteConnected: Boolean,
    public val syncActive: Boolean,
)

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

public data class DeviceStatus(
    public val batteryLevel: Int,
    public val batteryMv: Int? = null,
    public val storageTotalMb: Int,
    public val storageUsedMb: Int,
    public val state: WireValue<DeviceState>,
    public val pendingRecordings: Int,
    public val lastTimeSyncAt: Instant?,
    public val signalStrength: Int = 0,
    public val flags: DeviceFlags,
    public val timestamp: UInt,
    public val lteStatus: WireValue<LteStatus>,
    public val lteSignalQuality: Int? = null,
    public val wifiStatus: WireValue<WifiRadioStatus>? = null,
    public val modemInfo: ModemInfo? = null,
)

public class DiscoveredDevice(
    public val id: String,
    public val name: String? = null,
    public val deviceType: DeviceType? = null,
    public val firmwareVersion: String? = null,
    public val macAddress: String? = null,
    public val pairingState: PairingState? = null,
    public val rssi: Int,
    manufacturerData: ByteArray? = null,
    public val discoveredAt: Instant = Instant.now(),
) {
    private val storedManufacturerData: ByteArray? = manufacturerData?.copyOf()
    public val manufacturerData: ByteArray? get() = storedManufacturerData?.copyOf()

    override fun equals(other: Any?): Boolean = other is DiscoveredDevice &&
        id == other.id && name == other.name && deviceType == other.deviceType &&
        firmwareVersion == other.firmwareVersion && macAddress == other.macAddress &&
        pairingState == other.pairingState && rssi == other.rssi &&
        storedManufacturerData.contentEqualsNullable(other.storedManufacturerData) &&
        discoveredAt == other.discoveredAt

    override fun hashCode(): Int {
        var result = id.hashCode()
        result = 31 * result + (name?.hashCode() ?: 0)
        result = 31 * result + (deviceType?.hashCode() ?: 0)
        result = 31 * result + (firmwareVersion?.hashCode() ?: 0)
        result = 31 * result + (macAddress?.hashCode() ?: 0)
        result = 31 * result + (pairingState?.hashCode() ?: 0)
        result = 31 * result + rssi
        result = 31 * result + (storedManufacturerData?.contentHashCode() ?: 0)
        return 31 * result + discoveredAt.hashCode()
    }
}

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

internal fun ByteArray?.contentEqualsNullable(other: ByteArray?): Boolean = when {
    this == null -> other == null
    other == null -> false
    else -> contentEquals(other)
}
