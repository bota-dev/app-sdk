@file:Suppress("DEPRECATION")

package com.bota.sdk

import dev.bota.sdk.RecordingSyncEvent
import dev.bota.sdk.model.ProvisioningMaterial
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody

@Deprecated("Use dev.bota.sdk.DeviceManager", ReplaceWith("DeviceManager", "dev.bota.sdk.DeviceManager"))
public class DeviceManager(private val ble: BluetoothTransport) {
    private var runtime: CompatibilityRuntime? = null
    private var connected: ConnectedDevice? = null
    private var scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val alive = AtomicBoolean(true)
    private val scanning = AtomicBoolean(false)

    internal fun attach(runtime: CompatibilityRuntime) {
        this.runtime = runtime
        alive.set(true)
    }

    public suspend fun currentBluetoothState(): BluetoothState = configured().bluetoothState()

    public fun startScan(options: ScanOptions = ScanOptions()): Flow<DiscoveredDevice> = flow {
        val client = client()
        scanning.set(true)
        emitAll(
            client.devices.startScan(options.timeoutMs.coerceAtLeast(0).toULong(), options.allowDuplicates)
                .filter { alive.get() && scanning.get() }
                .map { it.toLegacy() }
                .filter { candidate ->
                    (options.deviceTypes == null || candidate.deviceType in options.deviceTypes) &&
                        (options.pairingState == null || candidate.pairingState == options.pairingState) &&
                        (options.minRssi == null || candidate.rssi >= options.minRssi)
                },
        )
    }.catch { throw it.toLegacyError() }

    public fun stopScan(): Unit {
        scanning.set(false)
        val value = runtime ?: return
        scope.launch { runCatching { value.requireClient().devices.cancelCurrentOperation() } }
    }

    public suspend fun connect(device: DiscoveredDevice): ConnectedDevice {
        return try {
            client().devices.connect(device.toNative()).toLegacy().also { connected = it }
        } catch (error: Throwable) {
            throw error.toLegacyError()
        }
    }

    public suspend fun disconnect(device: ConnectedDevice): Unit {
        if (connected?.id != device.id) return
        try {
            client().devices.disconnect()
            connected = null
        } catch (error: Throwable) {
            throw error.toLegacyError()
        }
    }

    public fun isConnected(deviceId: String): Boolean = connected?.id == deviceId

    public suspend fun getStatus(device: ConnectedDevice): DeviceStatus {
        requireConnected(device)
        return try {
            client().devices.readStatus().toLegacy()
        } catch (error: Throwable) {
            throw error.toLegacyError()
        }
    }

    public fun subscribeToStatus(device: ConnectedDevice): Flow<DeviceStatus> = flow {
        requireConnected(device)
        emitAll(client().devices.statusUpdates().filter { alive.get() }.map { it.toLegacy() })
    }.catch { throw it.toLegacyError() }

    public suspend fun provision(device: ConnectedDevice, token: String, environment: String = "production") {
        requireConnected(device)
        try {
            client().provisioning.provision(device.toNative()) {
                ProvisioningMaterial(environment.toByteArray(), token.toByteArray(), device.mtu.toULong())
            }
        } catch (error: Throwable) {
            throw error.toLegacyError()
        }
    }

    public suspend fun writeConnectionSettings(device: ConnectedDevice, settings: DeviceConnectionSettings) {
        requireConnected(device)
        try {
            client().provisioning.writeConnectionSettings(settings.toNative(), device.toNative())
        } catch (error: Throwable) {
            throw error.toLegacyError()
        }
    }

    public fun destroy() {
        alive.set(false)
        scanning.set(false)
        connected = null
        scope.cancel()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    }

    private fun configured(): CompatibilityRuntime = runtime ?: throw BotaSdkException.UnsupportedOperation(
        "Standalone DeviceManager is not supported; use BotaClient.devices",
    )

    private fun client(): dev.bota.sdk.BotaDeviceClient = configured().requireClient()

    private fun requireConnected(device: ConnectedDevice) {
        if (connected?.id != device.id) throw BotaSdkException.NotConnected(device.id)
    }
}

@Deprecated("Use dev.bota.sdk.RecordingManager", ReplaceWith("RecordingManager", "dev.bota.sdk.RecordingManager"))
public class RecordingManager(private val ble: BluetoothTransport) {
    private var runtime: CompatibilityRuntime? = null
    private var scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val alive = AtomicBoolean(true)

    internal fun attach(runtime: CompatibilityRuntime) {
        this.runtime = runtime
        alive.set(true)
    }

    public suspend fun listRecordings(device: ConnectedDevice): List<DeviceRecording> = try {
        client().recordings.listRecordings(device.toNative()).map { it.toLegacy() }
    } catch (error: Throwable) {
        throw error.toLegacyError()
    }

    public fun syncRecording(
        device: ConnectedDevice,
        recording: DeviceRecording,
        uploadInfo: UploadInfo,
    ): Flow<SyncProgress> = flow {
        emit(SyncProgress(SyncStage.PREPARING, 0.0, totalBytes = recording.fileSizeBytes, recordingId = uploadInfo.recordingId))
        client().recordings.syncRecording(device.toNative(), recording.toNative()).collect { event ->
            if (!alive.get()) return@collect
            when (event) {
                is RecordingSyncEvent.Progress -> emit(
                    SyncProgress(
                        stage = SyncStage.TRANSFERRING,
                        progress = ratio(event.progress.completedBytes, event.progress.totalBytes),
                        bytesTransferred = event.progress.completedBytes.toInt(),
                        totalBytes = event.progress.totalBytes.toInt(),
                        recordingId = uploadInfo.recordingId,
                    ),
                )
                is RecordingSyncEvent.Completed -> {
                    emit(SyncProgress(SyncStage.UPLOADING, 0.0, totalBytes = recording.fileSizeBytes, recordingId = uploadInfo.recordingId))
                    try {
                        upload(event.path, uploadInfo)
                    } finally {
                        Files.deleteIfExists(event.path)
                    }
                    emit(SyncProgress(SyncStage.COMPLETED, 1.0, recording.fileSizeBytes, recording.fileSizeBytes, recording.fileSizeBytes, uploadInfo.recordingId))
                }
            }
        }
    }.catch { error ->
        if (error is CancellationException) throw error
        emit(SyncProgress(SyncStage.FAILED, 0.0, totalBytes = recording.fileSizeBytes, recordingId = uploadInfo.recordingId, error = error.message))
    }

    public suspend fun confirmSync(device: ConnectedDevice, recordingUuid: ByteArray) {
        try {
            client().recordings.confirmRecording(device.toNative(), recordingUuid.toHex())
        } catch (error: Throwable) {
            throw error.toLegacyError()
        }
    }

    public fun destroy() {
        alive.set(false)
        CoroutineScope(SupervisorJob() + Dispatchers.Default).launch {
            runCatching { runtime?.requireClient()?.recordings?.cancelCurrentOperation() }
        }
        scope.cancel()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    }

    private fun client(): dev.bota.sdk.BotaDeviceClient = runtime?.requireClient()
        ?: throw BotaSdkException.UnsupportedOperation("Standalone RecordingManager is not supported; use BotaClient.recordings")

    private suspend fun upload(path: java.nio.file.Path, uploadInfo: UploadInfo) = withContext(Dispatchers.IO) {
        val mediaType = uploadInfo.contentType?.toMediaTypeOrNull()
        val uploadRequest = Request.Builder()
            .url(uploadInfo.uploadUrl)
            .put(path.toFile().asRequestBody(mediaType))
            .build()
        OkHttpClient().newCall(uploadRequest).execute().use { response ->
            if (!response.isSuccessful) error("Recording upload failed with HTTP ${response.code}")
        }
        uploadInfo.completeUrl?.let { completeUrl ->
            val builder = Request.Builder().url(completeUrl).post(byteArrayOf().toRequestBody(null))
            uploadInfo.uploadToken?.let { builder.header("Authorization", "Bearer $it") }
            OkHttpClient().newCall(builder.build()).execute().use { response ->
                if (!response.isSuccessful) error("Recording completion failed with HTTP ${response.code}")
            }
        }
    }
}

@Deprecated("Use dev.bota.sdk.OTAManager", ReplaceWith("OTAManager", "dev.bota.sdk.OTAManager"))
public class OtaManager(private val ble: BluetoothTransport) {
    private var runtime: CompatibilityRuntime? = null

    internal fun attach(runtime: CompatibilityRuntime) {
        this.runtime = runtime
    }

    public fun destroy() {
        @Suppress("UNUSED_EXPRESSION")
        ble
        runtime = null
    }
}

private fun ratio(completed: ULong, total: ULong): Double =
    if (total == 0uL) 0.0 else (completed.toDouble() / total.toDouble()).coerceIn(0.0, 1.0)

private fun ByteArray.toHex(): String = joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
