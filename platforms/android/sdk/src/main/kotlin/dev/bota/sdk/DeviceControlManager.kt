package dev.bota.sdk

import dev.bota.sdk.internal.DeviceRuntime
import dev.bota.sdk.internal.bluetooth.BotaBluetoothUUIDs
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.PairingState
import dev.bota.sdk.model.RecordingControlResult
import dev.bota.sdk.model.RecordingState
import java.util.Base64
import java.util.TimeZone
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

public enum class DeviceApiEnvironment { Development, Gamma, Production }

internal enum class RecordingControlCommand { Start, Stop }

public class DeviceControlManager internal constructor() {
    private data class RecordingStateObserver(
        val runtime: DeviceRuntime,
        val deviceId: String,
        val channel: SendChannel<RecordingState>,
        val task: Job,
    )

    private val lock = Any()
    private var runtime: DeviceRuntime? = null
    private var callbackScope: CoroutineScope? = null
    private val recordingStateObservers = mutableMapOf<UUID, RecordingStateObserver>()

    internal fun attach(runtime: DeviceRuntime) {
        synchronized(lock) {
            this.runtime = runtime
            callbackScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        }
    }

    internal suspend fun detach() {
        stopAllRecordingStateObservers()
        synchronized(lock) {
            callbackScope?.cancel()
            callbackScope = null
            runtime = null
        }
    }

    public suspend fun isProvisioned(device: ConnectedDevice): Boolean =
        readPairingState(device) == PairingState.Paired

    public suspend fun readPairingState(device: ConnectedDevice): PairingState =
        performOperation(device, BotaOperation.Decode) { configured ->
            val value = configured.directRead(
                device.id,
                BotaBluetoothUUIDs.ProvisioningService,
                BotaBluetoothUUIDs.PairingState,
            ).firstOrNull()?.toUByte() ?: 0u
            pairingState(value)
        }

    public suspend fun readPublicKey(device: ConnectedDevice): String? =
        performOperation(device, BotaOperation.Decode) { configured ->
            runCatching {
                configured.directRead(
                    device.id,
                    BotaBluetoothUUIDs.AuthService,
                    BotaBluetoothUUIDs.DevicePublicKey,
                )
            }.getOrNull()?.takeIf { it.size == 64 }?.hexString()
        }

    public suspend fun readAuthNonce(device: ConnectedDevice): String? =
        performOperation(device, BotaOperation.Decode) { configured ->
            runCatching {
                configured.directRead(
                    device.id,
                    BotaBluetoothUUIDs.AuthService,
                    BotaBluetoothUUIDs.AuthNonce,
                )
            }.getOrNull()?.takeIf { it.size == 16 }?.hexString()
        }

    public suspend fun setApiEndpoint(environment: DeviceApiEnvironment, device: ConnectedDevice) {
        write(
            byteArrayOf(endpointCode(environment)),
            BotaBluetoothUUIDs.ProvisioningService,
            BotaBluetoothUUIDs.ApiEndpoint,
            device,
        )
    }

    public suspend fun deliverCertificate(
        certificatePem: String,
        privateKeyPem: String,
        device: ConnectedDevice,
    ) {
        performOperation(device, BotaOperation.Encode) { configured ->
            val payload = "${certificatePem.trim()}\n${privateKeyPem.trim()}\n".encodeToByteArray()
            configured.createProvisioningChunks(payload, device.mtu).forEach { chunk ->
                configured.directWrite(
                    device.id,
                    BotaBluetoothUUIDs.AuthService,
                    BotaBluetoothUUIDs.DeviceCertificate,
                    chunk,
                )
            }
        }
    }

    public suspend fun deliverBackendPublicKey(publicKey: ByteArray, device: ConnectedDevice) {
        if (publicKey.size != 32) throw invalidControl("backend public key must be 32 bytes")
        write(
            publicKey,
            BotaBluetoothUUIDs.AuthService,
            BotaBluetoothUUIDs.BackendPublicKey,
            device,
        )
    }

    public suspend fun writeGrant(grantBlob: String, device: ConnectedDevice) {
        val grant = grantData(grantBlob)
        write(grant, BotaBluetoothUUIDs.ControlService, BotaBluetoothUUIDs.DeviceCommand, device)
    }

    public suspend fun requestStartRecording(
        device: ConnectedDevice,
        grantBlob: String,
    ): RecordingControlResult = requestRecordingControl(RecordingControlCommand.Start, device, grantBlob)

    public suspend fun requestStopRecording(
        device: ConnectedDevice,
        grantBlob: String,
    ): RecordingControlResult = requestRecordingControl(RecordingControlCommand.Stop, device, grantBlob)

    public suspend fun readRecordingState(device: ConnectedDevice): RecordingState =
        performOperation(device, BotaOperation.ReadStatus) { configured ->
            configured.parseRecordingState(
                configured.directRead(
                    device.id,
                    BotaBluetoothUUIDs.ControlService,
                    BotaBluetoothUUIDs.RecordingStatus,
                ),
            )
        }

    public fun recordingStateUpdates(device: ConnectedDevice): Flow<RecordingState> {
        val configured = configuredRuntime()
        configured.connection.require(device)
        configured.authorize(BotaOperation.ReadStatus)
        val cleanupScope = synchronized(lock) { callbackScope } ?: unavailable()
        return callbackFlow {
            val source = configured.directSubscribe(
                device.id,
                BotaBluetoothUUIDs.ControlService,
                BotaBluetoothUUIDs.RecordingStatus,
            )
            val id = UUID.randomUUID()
            val collector = launch(start = CoroutineStart.LAZY) {
                try {
                    source.collect { send(configured.parseRecordingState(it)) }
                    close()
                } catch (error: CancellationException) {
                    close()
                    throw error
                } catch (error: Throwable) {
                    close(error)
                } finally {
                    withContext(NonCancellable) {
                        stopRecordingStateObserver(id, cancelTask = false, closeChannel = false)
                    }
                }
            }
            synchronized(lock) {
                recordingStateObservers[id] = RecordingStateObserver(
                    configured,
                    device.id,
                    channel,
                    collector,
                )
            }
            collector.start()
            awaitClose {
                collector.cancel()
                cleanupScope.launch {
                    stopRecordingStateObserver(id, cancelTask = true, closeChannel = true)
                }
            }
        }
    }

    public suspend fun syncTime(
        epochMilliseconds: Long = System.currentTimeMillis(),
        timezoneOffsetMinutes: Int? = null,
        device: ConnectedDevice,
    ) {
        if (epochMilliseconds < 0) throw invalidControl("time sync timestamp is before 1970")
        val offset = timezoneOffsetMinutes ?: TimeZone.getDefault().getOffset(epochMilliseconds) / 60_000
        if (offset !in Short.MIN_VALUE..Short.MAX_VALUE) {
            throw invalidControl("time sync timezone offset is out of range")
        }
        performOperation(device, BotaOperation.Encode) { configured ->
            configured.directWrite(
                device.id,
                BotaBluetoothUUIDs.ControlService,
                BotaBluetoothUUIDs.TimeSync,
                configured.createTimeSyncData(epochMilliseconds.toULong(), offset.toShort()),
            )
        }
    }

    private suspend fun requestRecordingControl(
        command: RecordingControlCommand,
        device: ConnectedDevice,
        grantBlob: String,
    ): RecordingControlResult {
        val grant = grantData(grantBlob)
        return performOperation(device, BotaOperation.Encode) { configured ->
            configured.directWrite(
                device.id,
                BotaBluetoothUUIDs.ControlService,
                BotaBluetoothUUIDs.DeviceCommand,
                grant,
            )
            if (command == RecordingControlCommand.Stop) configured.delay(50)
            withRecordingSubscription(configured, device.id) { notifications ->
                if (command == RecordingControlCommand.Stop) configured.delay(50)
                configured.directWrite(
                    device.id,
                    BotaBluetoothUUIDs.ControlService,
                    BotaBluetoothUUIDs.RecordingControl,
                    configured.createRecordingControlCommand(command),
                )
                awaitRecordingControlResult(notifications, configured)
            }
        }
    }

    private suspend fun write(
        data: ByteArray,
        service: UUID,
        characteristic: UUID,
        device: ConnectedDevice,
    ) {
        performOperation(device, BotaOperation.Encode) { configured ->
            configured.directWrite(device.id, service, characteristic, data)
        }
    }

    private suspend fun <T> performOperation(
        device: ConnectedDevice,
        operation: BotaOperation,
        body: suspend (DeviceRuntime) -> T,
    ): T {
        val configured = configuredRuntime()
        configured.connection.require(device)
        configured.authorize(operation)
        val id = UUID.randomUUID()
        configured.operations.begin(id, operation)
        return try {
            body(configured)
        } finally {
            configured.operations.end(id)
        }
    }

    private suspend fun <T> withRecordingSubscription(
        configured: DeviceRuntime,
        deviceId: String,
        body: suspend (Flow<ByteArray>) -> T,
    ): T {
        val source = configured.directSubscribe(
            deviceId,
            BotaBluetoothUUIDs.ControlService,
            BotaBluetoothUUIDs.RecordingStatus,
        )
        return try {
            body(source)
        } finally {
            withContext(NonCancellable) {
                runCatching {
                    configured.directUnsubscribe(
                        deviceId,
                        BotaBluetoothUUIDs.ControlService,
                        BotaBluetoothUUIDs.RecordingStatus,
                    )
                }
            }
        }
    }

    private suspend fun awaitRecordingControlResult(
        notifications: Flow<ByteArray>,
        configured: DeviceRuntime,
    ): RecordingControlResult = try {
        withTimeout(recordingControlTimeoutMilliseconds) {
            configured.parseRecordingControlResult(notifications.first())
        }
    } catch (_: TimeoutCancellationException) {
        throw BotaSDKError.Core(
            BotaErrorCode.Timeout,
            BotaOperation.Encode,
            retryable = true,
            protocolStatus = null,
            detail = "Recording control timed out",
        )
    } catch (_: NoSuchElementException) {
        throw BotaSDKError.Core(
            BotaErrorCode.UnexpectedEvent,
            BotaOperation.Encode,
            retryable = true,
            protocolStatus = null,
            detail = "Recording control ended without a result",
        )
    }

    private suspend fun stopRecordingStateObserver(
        id: UUID,
        cancelTask: Boolean,
        closeChannel: Boolean,
    ) {
        val observer = synchronized(lock) { recordingStateObservers.remove(id) } ?: return
        if (cancelTask) observer.task.cancel()
        if (closeChannel) observer.channel.close()
        runCatching {
            observer.runtime.directUnsubscribe(
                observer.deviceId,
                BotaBluetoothUUIDs.ControlService,
                BotaBluetoothUUIDs.RecordingStatus,
            )
        }
    }

    private suspend fun stopAllRecordingStateObservers() {
        val observers = synchronized(lock) {
            recordingStateObservers.values.toList().also { recordingStateObservers.clear() }
        }
        observers.forEach { observer ->
            observer.task.cancel()
            observer.channel.close()
            runCatching {
                observer.runtime.directUnsubscribe(
                    observer.deviceId,
                    BotaBluetoothUUIDs.ControlService,
                    BotaBluetoothUUIDs.RecordingStatus,
                )
            }
        }
    }

    private fun configuredRuntime(): DeviceRuntime = synchronized(lock) { runtime } ?: unavailable()

    private fun pairingState(value: UByte): PairingState = when (value.toInt()) {
        0 -> PairingState.Unpaired
        1 -> PairingState.Pairing
        2 -> PairingState.Paired
        3 -> PairingState.Error
        else -> PairingState.Unknown(value)
    }

    private fun endpointCode(environment: DeviceApiEnvironment): Byte = when (environment) {
        DeviceApiEnvironment.Development -> 0
        DeviceApiEnvironment.Production -> 1
        DeviceApiEnvironment.Gamma -> 2
    }

    private fun grantData(value: String): ByteArray {
        val data = runCatching { Base64.getDecoder().decode(value) }
            .getOrElse { throw invalidControl("grant blob is not valid base64 data") }
        if (data.isEmpty()) throw invalidControl("grant blob is not valid base64 data")
        return data
    }
}

private fun ByteArray.hexString(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }

private fun invalidControl(detail: String): BotaSDKError.Core = BotaSDKError.Core(
    code = BotaErrorCode.InvalidInput,
    operation = BotaOperation.Validate,
    retryable = false,
    protocolStatus = null,
    detail = detail,
)

private const val recordingControlTimeoutMilliseconds: Long = 30_000
