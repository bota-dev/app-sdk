@file:Suppress("DEPRECATION")

package com.bota.sdk

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow

@Deprecated("Use the native Android Bluetooth host", ReplaceWith("BotaConfiguration", "dev.bota.sdk.BotaConfiguration"))
public enum class BluetoothState { UNKNOWN, RESETTING, UNSUPPORTED, UNAUTHORIZED, POWERED_OFF, POWERED_ON }

@Deprecated("Use DeviceManager.startScan arguments", ReplaceWith("DeviceManager", "dev.bota.sdk.DeviceManager"))
public data class ScanOptions(
    public val timeoutMs: Long = 30_000,
    public val deviceTypes: List<DeviceType>? = null,
    public val pairingState: PairingState? = null,
    public val minRssi: Int? = null,
    public val allowDuplicates: Boolean = false,
)

@Deprecated("The replacement SDK owns its native Bluetooth GATT host", ReplaceWith("BotaConfiguration", "dev.bota.sdk.BotaConfiguration"))
public interface BluetoothTransport {
    public suspend fun bluetoothState(): BluetoothState
    public fun scan(options: ScanOptions = ScanOptions()): Flow<DiscoveredDevice>
    public fun stopScan()
    public suspend fun connect(device: DiscoveredDevice): ConnectedDevice
    public suspend fun disconnect(device: ConnectedDevice)
    public fun isConnected(deviceId: String): Boolean
    public suspend fun read(deviceId: String, service: String, characteristic: String): ByteArray
    public suspend fun write(
        deviceId: String,
        service: String,
        characteristic: String,
        data: ByteArray,
        withResponse: Boolean = true,
    )
    public fun notifications(deviceId: String, service: String, characteristic: String): Flow<ByteArray>
}

@Deprecated("The replacement SDK owns its native Bluetooth GATT host", ReplaceWith("BotaConfiguration", "dev.bota.sdk.BotaConfiguration"))
public class UnimplementedBluetoothTransport : BluetoothTransport {
    override suspend fun bluetoothState(): BluetoothState = BluetoothState.UNKNOWN
    override fun scan(options: ScanOptions): Flow<DiscoveredDevice> = emptyFlow()
    override fun stopScan(): Unit = Unit
    override suspend fun connect(device: DiscoveredDevice): ConnectedDevice =
        throw BotaSdkException.UnsupportedOperation("Use the replacement SDK native Bluetooth GATT host")
    override suspend fun disconnect(device: ConnectedDevice): Unit = Unit
    override fun isConnected(deviceId: String): Boolean = false
    override suspend fun read(deviceId: String, service: String, characteristic: String): ByteArray =
        throw BotaSdkException.NotConnected(deviceId)
    override suspend fun write(
        deviceId: String,
        service: String,
        characteristic: String,
        data: ByteArray,
        withResponse: Boolean,
    ): Unit = Unit
    override fun notifications(deviceId: String, service: String, characteristic: String): Flow<ByteArray> = emptyFlow()
}

@Deprecated("Raw protocol helpers moved to the Rust core", ReplaceWith("BotaDeviceClient", "dev.bota.sdk.BotaDeviceClient"))
public object BotaProtocol {
    public const val serviceBotaControl: String = "B07A0002-0000-1000-8000-00805F9B34FB"
    public const val serviceBotaProvisioning: String = "B07A0003-0000-1000-8000-00805F9B34FB"
    public const val serviceBotaStorage: String = "B07A0004-0000-1000-8000-00805F9B34FB"
    public const val serviceBotaAuth: String = "B07A0005-0000-1000-8000-00805F9B34FB"
    public const val serviceBotaWifiConfig: String = "B07A0006-0000-1000-8000-00805F9B34FB"
    public const val charDeviceStatus: String = "B07A0002-0001-1000-8000-00805F9B34FB"
    public const val charTransferControl: String = "B07A0004-0004-1000-8000-00805F9B34FB"

    public fun parseDeviceStatus(data: ByteArray): DeviceStatus = unsupported(data)
    public fun parseRecordingEntry(data: ByteArray): DeviceRecording = unsupported(data)
    public fun parseTransferPacket(data: ByteArray): TransferPacket = unsupported(data)
    public fun serializeConnectionSettings(settings: DeviceConnectionSettings): ByteArray = unsupported(settings)

    private fun unsupported(@Suppress("UNUSED_PARAMETER") value: Any): Nothing =
        throw BotaSdkException.UnsupportedOperation("Raw protocol helpers moved to the Rust core")
}
