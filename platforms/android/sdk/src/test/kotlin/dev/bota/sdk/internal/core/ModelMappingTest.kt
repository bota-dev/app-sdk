package dev.bota.sdk.internal.core

import dev.bota.sdk.BotaErrorCode
import dev.bota.sdk.BotaOperation
import dev.bota.sdk.BotaSDKError
import dev.bota.sdk.model.DeviceConnectionSettings
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.TransferPacket
import dev.bota.sdk.model.TransferPacketType
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ModelMappingTest {
    @Test
    fun botaNoteNormalizationRemovesCellularEverywhere() {
        val settings = DeviceConnectionSettings(
            enabledConnections = DeviceConnectionSettings.EnabledConnections(wifi = true, cellular = true),
            heartbeatEnabledConnections = DeviceConnectionSettings.EnabledConnections(wifi = true, cellular = true),
            uploadNetworkPreference = listOf(
                DeviceConnectionSettings.ConnectionType.Wifi,
                DeviceConnectionSettings.ConnectionType.Cellular,
                DeviceConnectionSettings.ConnectionType.Ble,
            ),
            powerManagement = DeviceConnectionSettings.PowerManagement(
                wifiIdleTimeoutSeconds = 180,
                cellularIdleTimeoutSeconds = 180,
            ),
            streamingEnabled = false,
            streamingFlushIntervalSeconds = 60,
        )

        val normalized = settings.normalized(DeviceType.BotaNote)

        assertFalse(normalized.enabledConnections.cellular)
        assertFalse(normalized.heartbeatEnabledConnections.cellular)
        assertEquals(
            listOf(DeviceConnectionSettings.ConnectionType.Wifi, DeviceConnectionSettings.ConnectionType.Ble),
            normalized.uploadNetworkPreference,
        )
    }

    @Test
    fun transferPacketUsesByteContentEqualityAndDefensiveCopies() {
        val source = byteArrayOf(1, 2, 3)
        val first = TransferPacket(type = TransferPacketType.Data, data = source)
        val second = TransferPacket(type = TransferPacketType.Data, data = byteArrayOf(1, 2, 3))

        source[0] = 9

        assertEquals(first, second)
        assertArrayEquals(byteArrayOf(1, 2, 3), first.data)
        assertEquals(first.hashCode(), second.hashCode())
    }

    @Test
    fun coreErrorsExposeStableMachineReadableFields() {
        val error = BotaSDKError.Core(
            code = BotaErrorCode.TruncatedPacket,
            operation = BotaOperation.Decode,
            retryable = false,
            protocolStatus = 7u,
            detail = "diagnostic only",
        )

        assertEquals(BotaErrorCode.TruncatedPacket, error.code)
        assertEquals(BotaOperation.Decode, error.operation)
        assertFalse(error.retryable)
        assertEquals(7u.toUShort(), error.protocolStatus)
    }
}
