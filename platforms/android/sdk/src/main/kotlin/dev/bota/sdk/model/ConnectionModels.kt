package dev.bota.sdk.model

public data class DeviceConnectionSettings(
    public val enabledConnections: EnabledConnections,
    public val heartbeatEnabledConnections: EnabledConnections = enabledConnections,
    public val heartbeatUnknownMask: UByte = 0u,
    public val uploadNetworkPreference: List<ConnectionType>,
    public val powerManagement: PowerManagement = PowerManagement(),
    public val streamingEnabled: Boolean = true,
    public val streamingFlushIntervalSeconds: Int = 60,
) {
    public data class EnabledConnections(
        public val wifi: Boolean,
        public val cellular: Boolean,
    )

    public data class PowerManagement(
        public val wifiIdleTimeoutSeconds: Int = 180,
        public val cellularIdleTimeoutSeconds: Int = 180,
    )

    public sealed interface ConnectionType {
        public data object Wifi : ConnectionType
        public data object Ble : ConnectionType
        public data object Cellular : ConnectionType
        public data class Unknown(public val rawValue: UByte) : ConnectionType

        public companion object
    }

    public fun normalized(model: DeviceType): DeviceConnectionSettings {
        if (model != DeviceType.BotaNote) return this
        return copy(
            enabledConnections = enabledConnections.copy(cellular = false),
            heartbeatEnabledConnections = heartbeatEnabledConnections.copy(cellular = false),
            uploadNetworkPreference = uploadNetworkPreference.filterNot { it == ConnectionType.Cellular },
        )
    }
}

public data class ParsedConnectionSettings(
    public val settings: DeviceConnectionSettings,
    public val supportedVersion: Boolean,
)

public sealed interface WiFiConfigResult {
    public data object Success : WiFiConfigResult
    public data object InvalidGrant : WiFiConfigResult
    public data object GrantExpired : WiFiConfigResult
    public data object DecryptionError : WiFiConfigResult
    public data object StorageError : WiFiConfigResult
    public data class Unknown(public val rawValue: UByte) : WiFiConfigResult
}
