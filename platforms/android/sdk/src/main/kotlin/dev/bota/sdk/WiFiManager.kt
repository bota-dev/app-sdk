package dev.bota.sdk

import dev.bota.sdk.internal.DeviceRuntime
import dev.bota.sdk.internal.bluetooth.BotaBluetoothUUIDs
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.DeviceWiFiScanResult
import dev.bota.sdk.model.WiFiConfigResult
import dev.bota.sdk.model.WiFiScanUpdate
import dev.bota.sdk.model.WiFiStatusInfo
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

public class WiFiManager internal constructor() {
    private data class ActiveOperation(
        val id: UUID,
        val task: Deferred<*>,
        val runtime: DeviceRuntime,
    )

    private data class StatusObserver(
        val runtime: DeviceRuntime,
        val deviceId: String,
        val channel: SendChannel<WiFiStatusInfo>,
        val task: Job,
    )

    private val lock = Any()
    private var runtime: DeviceRuntime? = null
    private var callbackScope: CoroutineScope? = null
    private var activeOperation: ActiveOperation? = null
    private val statusObservers = mutableMapOf<UUID, StatusObserver>()

    internal fun attach(runtime: DeviceRuntime) {
        synchronized(lock) {
            this.runtime = runtime
            callbackScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        }
    }

    internal suspend fun detach() {
        val operation = synchronized(lock) { activeOperation }
        operation?.task?.cancelAndJoin()
        operation?.runtime?.operations?.end(operation.id)
        synchronized(lock) { if (activeOperation?.id == operation?.id) activeOperation = null }
        stopAllStatusObservers()
        synchronized(lock) {
            callbackScope?.cancel()
            callbackScope = null
            runtime = null
        }
    }

    public suspend fun configure(
        device: ConnectedDevice,
        ssid: String,
        password: String,
        grantBlob: String,
    ): WiFiConfigResult = performOperation(device, BotaOperation.Provision) { configured ->
        val grant = configured.createWiFiGrantPacket(grantBlob)
        val credentials = configured.createWiFiCredentialPacket(ssid, password)
        configured.directWrite(
            device.id,
            BotaBluetoothUUIDs.WifiService,
            BotaBluetoothUUIDs.WifiGrant,
            grant,
        )
        withSubscription(configured, device.id, BotaBluetoothUUIDs.WifiStatus) { notifications ->
            configured.directWrite(
                device.id,
                BotaBluetoothUUIDs.WifiService,
                BotaBluetoothUUIDs.WifiCredential,
                credentials,
            )
            awaitConfigResult(notifications, configured)
        }
    }

    public suspend fun disconnect(device: ConnectedDevice): WiFiConfigResult =
        performOperation(device, BotaOperation.Provision) { configured ->
            val command = configured.createWiFiCredentialPacket("", "")
            withSubscription(configured, device.id, BotaBluetoothUUIDs.WifiStatus) { notifications ->
                configured.directWrite(
                    device.id,
                    BotaBluetoothUUIDs.WifiService,
                    BotaBluetoothUUIDs.WifiCredential,
                    command,
                )
                awaitConfigResult(notifications, configured)
            }
        }

    public suspend fun readStatus(device: ConnectedDevice): WiFiStatusInfo =
        performOperation(device, BotaOperation.ReadStatus) { configured ->
            configured.parseWiFiStatusInfo(
                configured.directRead(
                    device.id,
                    BotaBluetoothUUIDs.WifiService,
                    BotaBluetoothUUIDs.WifiStatus,
                ),
            )
        }

    public fun statusUpdates(device: ConnectedDevice): Flow<WiFiStatusInfo> {
        val configured = configuredRuntime()
        configured.connection.require(device)
        configured.authorize(BotaOperation.ReadStatus)
        val cleanupScope = synchronized(lock) { callbackScope } ?: unavailable()
        return callbackFlow {
            val source = configured.directSubscribe(
                device.id,
                BotaBluetoothUUIDs.WifiService,
                BotaBluetoothUUIDs.WifiStatus,
            )
            val id = UUID.randomUUID()
            val collector = launch(start = CoroutineStart.LAZY) {
                try {
                    source.collect { send(configured.parseWiFiStatusInfo(it)) }
                    close()
                } catch (error: CancellationException) {
                    close()
                    throw error
                } catch (error: Throwable) {
                    close(error)
                } finally {
                    withContext(NonCancellable) {
                        stopStatusObserver(id, cancelTask = false, closeChannel = false)
                    }
                }
            }
            synchronized(lock) {
                statusObservers[id] = StatusObserver(configured, device.id, channel, collector)
            }
            collector.start()
            awaitClose {
                collector.cancel()
                cleanupScope.launch { stopStatusObserver(id, cancelTask = true, closeChannel = true) }
            }
        }
    }

    public suspend fun scanNetworks(device: ConnectedDevice): DeviceWiFiScanResult =
        performOperation(device, BotaOperation.ReadStatus) { configured ->
            val command = configured.createWiFiScanCommand()
            withSubscription(configured, device.id, BotaBluetoothUUIDs.WifiScan) { notifications ->
                configured.directWrite(
                    device.id,
                    BotaBluetoothUUIDs.WifiService,
                    BotaBluetoothUUIDs.WifiScan,
                    command,
                )
                awaitScanResult(notifications, configured)
            }
        }

    public suspend fun cancelCurrentOperation() {
        val operation = synchronized(lock) { activeOperation } ?: return
        operation.task.cancelAndJoin()
        operation.runtime.operations.end(operation.id)
        synchronized(lock) { if (activeOperation?.id == operation.id) activeOperation = null }
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
        return kotlinx.coroutines.coroutineScope {
            val task = async(start = CoroutineStart.LAZY) { body(configured) }
            synchronized(lock) { activeOperation = ActiveOperation(id, task, configured) }
            task.start()
            try {
                task.await()
            } catch (error: CancellationException) {
                throw cancelled(operation)
            } finally {
                synchronized(lock) { if (activeOperation?.id == id) activeOperation = null }
                configured.operations.end(id)
            }
        }
    }

    private suspend fun <T> withSubscription(
        configured: DeviceRuntime,
        deviceId: String,
        characteristic: UUID,
        body: suspend (Flow<ByteArray>) -> T,
    ): T {
        val source = configured.directSubscribe(deviceId, BotaBluetoothUUIDs.WifiService, characteristic)
        return try {
            body(source)
        } finally {
            withContext(NonCancellable) {
                runCatching {
                    configured.directUnsubscribe(deviceId, BotaBluetoothUUIDs.WifiService, characteristic)
                }
            }
        }
    }

    private suspend fun awaitConfigResult(
        notifications: Flow<ByteArray>,
        configured: DeviceRuntime,
    ): WiFiConfigResult = try {
        withTimeout(operationTimeoutMilliseconds) {
            notifications.mapNotNull { runCatching { configured.parseWiFiConfigResult(it) }.getOrNull() }.first()
        }
    } catch (_: TimeoutCancellationException) {
        throw timeout("WiFi configuration")
    } catch (_: NoSuchElementException) {
        throw endedWithoutResult("WiFi configuration")
    }

    private suspend fun awaitScanResult(
        notifications: Flow<ByteArray>,
        configured: DeviceRuntime,
    ): DeviceWiFiScanResult = try {
        withTimeout(operationTimeoutMilliseconds) {
            notifications.mapNotNull {
                when (val update = configured.parseWiFiScanResult(it)) {
                    is WiFiScanUpdate.Pending -> null
                    is WiFiScanUpdate.Done -> update.result
                }
            }.first()
        }
    } catch (_: TimeoutCancellationException) {
        throw timeout("WiFi scan")
    } catch (_: NoSuchElementException) {
        throw endedWithoutResult("WiFi scan")
    }

    private suspend fun stopStatusObserver(id: UUID, cancelTask: Boolean, closeChannel: Boolean) {
        val observer = synchronized(lock) { statusObservers.remove(id) } ?: return
        if (cancelTask) observer.task.cancel()
        if (closeChannel) observer.channel.close()
        runCatching {
            observer.runtime.directUnsubscribe(
                observer.deviceId,
                BotaBluetoothUUIDs.WifiService,
                BotaBluetoothUUIDs.WifiStatus,
            )
        }
    }

    private suspend fun stopAllStatusObservers() {
        val observers = synchronized(lock) { statusObservers.values.toList().also { statusObservers.clear() } }
        observers.forEach {
            it.task.cancel()
            it.channel.close()
            runCatching {
                it.runtime.directUnsubscribe(
                    it.deviceId,
                    BotaBluetoothUUIDs.WifiService,
                    BotaBluetoothUUIDs.WifiStatus,
                )
            }
        }
    }

    private fun configuredRuntime(): DeviceRuntime = synchronized(lock) { runtime } ?: unavailable()

    private companion object {
        fun timeout(label: String): BotaSDKError.Core = BotaSDKError.Core(
            BotaErrorCode.Timeout,
            BotaOperation.Provision,
            retryable = true,
            protocolStatus = null,
            detail = "$label timed out",
        )

        fun endedWithoutResult(label: String): BotaSDKError.Core = BotaSDKError.Core(
            BotaErrorCode.UnexpectedEvent,
            BotaOperation.Provision,
            retryable = true,
            protocolStatus = null,
            detail = "$label ended without a result",
        )

        fun cancelled(operation: BotaOperation): BotaSDKError.Core = BotaSDKError.Core(
            BotaErrorCode.Cancelled,
            operation,
            retryable = true,
            protocolStatus = null,
            detail = "WiFi operation was cancelled",
        )
    }
}

private const val operationTimeoutMilliseconds: Long = 30_000
