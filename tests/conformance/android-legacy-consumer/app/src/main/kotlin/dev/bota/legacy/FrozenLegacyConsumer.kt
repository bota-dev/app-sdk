@file:Suppress("DEPRECATION", "UNUSED_VARIABLE")

package dev.bota.legacy

import com.bota.sdk.*
import java.net.URL
import java.time.Instant
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow

// Generated from protocol/baseline/android-sdk-0f06d2a-public-api.txt.
// Baseline-SHA256: 4fc1abdb4b2b52ab95d39f2d030a8a4869cd8a7b0bb5ed68466e13b0a67f1f0a
public object FrozenLegacyConsumer {
    public fun exerciseLinkage(): String {
        val now = Instant.ofEpochSecond(1)
        val flags = DeviceFlags(false, false, false, false, false, false)
        val modem = ModemInfo("imei", "iccid", "operator", "rat", "band", "apn", "ready", 1, "127.0.0.1", 3700, "fw", false)
        val status = DeviceStatus(50, 3700, 32, 4, DeviceState.IDLE, 1, now, flags, 1, LteStatus.OFF, 10, WifiRadioStatus.OFF, modem)
        val recording = DeviceRecording("00112233445566778899aabbccddeeff", now, 1000, 1024, AudioCodec.OPUS_16K, false)
        val packet = TransferPacket(TransferPacketType.DATA, 1, byteArrayOf(1), 2, 3, 4, byteArrayOf(5), byteArrayOf(6), byteArrayOf(7), byteArrayOf(8))
        val settings = DeviceConnectionSettings(
            EnabledConnections(true, false),
            listOf(ConnectionType.WIFI, ConnectionType.BLE),
            PowerManagement(180, 0),
            false,
            60,
        )
        val discovered = DiscoveredDevice("id", "SERIAL123", DeviceType.BOTA_NOTE, "1.0.0", null, PairingState.UNPAIRED, -40, byteArrayOf(1), now)
        val connected = ConnectedDevice("id", "SERIAL123", DeviceType.BOTA_NOTE, "1.0.0", "1", false, ConnectionState.CONNECTED, 247)
        val upload = UploadInfo(URL("https://example.invalid/upload"), "recording", "token", URL("https://example.invalid/complete"), "audio/ogg")
        val progress = SyncProgress(SyncStage.PREPARING, 0.0, 0, 1024, 0, "recording", null, null)
        val scan = ScanOptions(1000, DeviceType.values().toList(), PairingState.UNPAIRED, -80, true)
        val config = BotaConfig("production", true, false, LogLevel.WARN, false)

        flags.copy(charging = true); flags.component1(); flags.component6()
        modem.copy(imei = null); modem.component1(); modem.component12()
        status.copy(batteryLevel = 51); status.component1(); status.component13()
        recording.copy(durationMs = 2); recording.component1(); recording.component6()
        packet.copy(sequenceNumber = 2); packet.component1(); packet.component10()
        settings.copy(streamingEnabled = true); settings.component1(); settings.component5()
        discovered.copy(rssi = -41); discovered.component1(); discovered.component9()
        connected.copy(mtu = 23); connected.component1(); connected.component8()
        upload.copy(recordingId = "other"); upload.component1(); upload.component5()
        progress.copy(progress = 1.0); progress.component1(); progress.component8()
        scan.copy(timeoutMs = 2); scan.component1(); scan.component5()
        config.copy(environment = "gamma"); config.component1(); config.component5()

        val enums = listOf(
            DeviceType.values().size,
            PairingState.values().size,
            ConnectionState.values().size,
            DeviceState.values().size,
            LteStatus.values().size,
            WifiRadioStatus.values().size,
            AudioCodec.values().size,
            TransferPacketType.values().size,
            ConnectionType.values().size,
            SyncStage.values().size,
            BluetoothState.values().size,
            SdkState.values().size,
            LogLevel.values().size,
        )

        val transport = FrozenTransport(status, connected)
        val client = BotaClient(transport)
        val defaultClient = BotaClient()
        val standaloneDevices = DeviceManager(transport)
        val standaloneRecordings = RecordingManager(transport)
        val standaloneOta = OtaManager(transport)
        client.state; client.bluetoothState; client.config; client.devices; client.recordings; client.ota
        client.isBluetoothReady; client.isInitialized; BotaClient.shared
        BotaSdkException.NotInitialized
        BotaSdkException.BluetoothUnavailable
        BotaSdkException.NotConnected("id").deviceId
        BotaSdkException.UnsupportedOperation("detail").detail

        runCatching { standaloneDevices.startScan() }
        runCatching { standaloneDevices.startScan(scan) }
        standaloneDevices.stopScan()
        standaloneDevices.isConnected("id")
        runCatching { standaloneDevices.subscribeToStatus(connected) }
        runCatching { standaloneRecordings.syncRecording(connected, recording, upload) }
        standaloneDevices.destroy(); standaloneRecordings.destroy(); standaloneOta.destroy()
        client.destroy(); defaultClient.destroy()

        listOf(
            BotaProtocol.serviceBotaControl,
            BotaProtocol.serviceBotaProvisioning,
            BotaProtocol.serviceBotaStorage,
            BotaProtocol.serviceBotaAuth,
            BotaProtocol.serviceBotaWifiConfig,
            BotaProtocol.charDeviceStatus,
            BotaProtocol.charTransferControl,
        )
        runCatching { BotaProtocol.parseDeviceStatus(ByteArray(14)) }
        runCatching { BotaProtocol.parseRecordingEntry(ByteArray(24)) }
        runCatching { BotaProtocol.parseTransferPacket(byteArrayOf(0xff.toByte())) }
        runCatching { BotaProtocol.serializeConnectionSettings(settings) }

        return BotaSdkVersion.current + enums.sum() + packet.sequenceNumber
    }

    public suspend fun exerciseSuspendCalls() {
        val now = Instant.ofEpochSecond(1)
        val device = DiscoveredDevice("id", "SERIAL123", DeviceType.BOTA_NOTE, "1", null, PairingState.UNPAIRED, -40, null, now)
        val connected = ConnectedDevice("id", "SERIAL123", DeviceType.BOTA_NOTE, "1", null, false, ConnectionState.CONNECTED, 247)
        val recording = DeviceRecording("00112233445566778899aabbccddeeff", now, 1, 1, AudioCodec.OPUS_16K)
        val upload = UploadInfo(URL("https://example.invalid/upload"), "recording")
        val settings = DeviceConnectionSettings(EnabledConnections(true, false), listOf(ConnectionType.WIFI))
        val client = BotaClient(FrozenTransport(null, connected))
        runCatching { client.configure() }
        runCatching { client.configure(BotaConfig()) }
        runCatching { client.waitForBluetooth() }
        runCatching { client.waitForBluetooth(1) }
        runCatching { client.devices.currentBluetoothState() }
        runCatching { client.devices.connect(device) }
        runCatching { client.devices.disconnect(connected) }
        runCatching { client.devices.getStatus(connected) }
        runCatching { client.devices.provision(connected, "token") }
        runCatching { client.devices.provision(connected, "token", "gamma") }
        runCatching { client.devices.writeConnectionSettings(connected, settings) }
        runCatching { client.recordings.listRecordings(connected) }
        runCatching { client.recordings.confirmSync(connected, ByteArray(16)) }
        runCatching { client.recordings.syncRecording(connected, recording, upload) }
        client.destroy()
    }
}

private class FrozenTransport(
    private val status: DeviceStatus?,
    private val connected: ConnectedDevice,
) : BluetoothTransport {
    override suspend fun bluetoothState(): BluetoothState = BluetoothState.POWERED_ON
    override fun scan(options: ScanOptions): Flow<DiscoveredDevice> = emptyFlow()
    override fun stopScan(): Unit = Unit
    override suspend fun connect(device: DiscoveredDevice): ConnectedDevice = connected
    override suspend fun disconnect(device: ConnectedDevice): Unit = Unit
    override fun isConnected(deviceId: String): Boolean = deviceId == connected.id
    override suspend fun read(deviceId: String, service: String, characteristic: String): ByteArray = ByteArray(24)
    override suspend fun write(deviceId: String, service: String, characteristic: String, data: ByteArray, withResponse: Boolean): Unit = Unit
    override fun notifications(deviceId: String, service: String, characteristic: String): Flow<ByteArray> = emptyFlow()
}
