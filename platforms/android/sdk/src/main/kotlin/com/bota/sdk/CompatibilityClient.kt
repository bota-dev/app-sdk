@file:Suppress("DEPRECATION")

package com.bota.sdk

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import dev.bota.sdk.BotaConfiguration
import dev.bota.sdk.BotaDeviceClient
import dev.bota.sdk.BotaSDKError
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

@Deprecated("Use BotaDeviceClient lifecycle", ReplaceWith("BotaDeviceClient", "dev.bota.sdk.BotaDeviceClient"))
public enum class SdkState { UNINITIALIZED, INITIALIZING, READY, ERROR }

@Deprecated("Logging is configured by the host application", ReplaceWith("BotaConfiguration", "dev.bota.sdk.BotaConfiguration"))
public enum class LogLevel { DEBUG, INFO, WARN, ERROR, NONE }

@Deprecated("Use dev.bota.sdk.BotaConfiguration", ReplaceWith("BotaConfiguration", "dev.bota.sdk.BotaConfiguration"))
public data class BotaConfig(
    public val environment: String = "production",
    public val backgroundSyncEnabled: Boolean = true,
    public val wifiOnlyUpload: Boolean = false,
    public val logLevel: LogLevel = LogLevel.WARN,
    public val debug: Boolean = false,
)

@Deprecated("Use dev.bota.sdk.BotaSDKError", ReplaceWith("BotaSDKError", "dev.bota.sdk.BotaSDKError"))
public sealed class BotaSdkException(message: String) : Exception(message) {
    public data object NotInitialized : BotaSdkException("SDK has not been initialized")
    public data object BluetoothUnavailable : BotaSdkException("Bluetooth is not powered on")
    public data class NotConnected(public val deviceId: String) : BotaSdkException("Device is not connected: $deviceId")
    public data class UnsupportedOperation(public val detail: String) : BotaSdkException(detail)
}

@Deprecated("Use dev.bota.sdk.BotaDeviceClient", ReplaceWith("BotaDeviceClient", "dev.bota.sdk.BotaDeviceClient"))
public class BotaClient(
    ble: BluetoothTransport = UnimplementedBluetoothTransport(),
) {
    private val runtime = CompatibilityRuntime(ble)

    public var state: SdkState = SdkState.UNINITIALIZED
        private set
    public var bluetoothState: BluetoothState = BluetoothState.UNKNOWN
        private set
    public var config: BotaConfig? = null
        private set

    public val devices: DeviceManager = DeviceManager(ble).also { it.attach(runtime) }
    public val recordings: RecordingManager = RecordingManager(ble).also { it.attach(runtime) }
    public val ota: OtaManager = OtaManager(ble).also { it.attach(runtime) }

    public val isBluetoothReady: Boolean get() = bluetoothState == BluetoothState.POWERED_ON
    public val isInitialized: Boolean get() = state == SdkState.READY

    public suspend fun configure(config: BotaConfig = BotaConfig()) {
        this.config = config
        state = SdkState.INITIALIZING
        try {
            runtime.configure(config)
            devices.attach(runtime)
            recordings.attach(runtime)
            ota.attach(runtime)
            bluetoothState = runtime.bluetoothState()
            state = SdkState.READY
        } catch (error: Throwable) {
            state = SdkState.ERROR
            throw error.toLegacyError()
        }
    }

    public suspend fun waitForBluetooth(timeoutMs: Long = 10_000) {
        val start = System.currentTimeMillis()
        while (bluetoothState != BluetoothState.POWERED_ON && System.currentTimeMillis() - start < timeoutMs) {
            delay(100)
            bluetoothState = runtime.bluetoothState()
        }
        if (bluetoothState != BluetoothState.POWERED_ON) throw BotaSdkException.BluetoothUnavailable
    }

    public fun destroy() {
        devices.destroy()
        recordings.destroy()
        ota.destroy()
        runtime.destroyAsync()
        config = null
        state = SdkState.UNINITIALIZED
    }

    public companion object {
        public val shared: BotaClient = BotaClient()
    }
}

internal class CompatibilityRuntime(private val transport: BluetoothTransport) {
    private val lifecycle = Mutex()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val initialized = AtomicBoolean(false)
    private var client = BotaDeviceClient()
    @Volatile
    private var destroyJob: Job? = null

    suspend fun configure(config: BotaConfig) {
        rejectUnsupported(config)
        if (transport !is UnimplementedBluetoothTransport) {
            throw BotaSdkException.UnsupportedOperation("Caller-supplied BluetoothTransport is not supported by the replacement SDK")
        }
        destroyJob?.join()
        lifecycle.withLock {
            destroyJob = null
            if (initialized.get()) return
            client.configure(BotaConfiguration(CompatibilityContextProvider.Holder.require()))
            initialized.set(true)
        }
    }

    fun requireClient(): BotaDeviceClient {
        if (!initialized.get()) throw BotaSdkException.NotInitialized
        return client
    }

    fun isInitialized(): Boolean = initialized.get()

    @Synchronized
    fun destroyAsync() {
        if (!initialized.getAndSet(false)) return
        destroyJob = scope.launch {
            lifecycle.withLock {
                client.destroy()
                client = BotaDeviceClient()
            }
        }
    }

    fun bluetoothState(): BluetoothState {
        val context = CompatibilityContextProvider.Holder.require()
        val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter ?: return BluetoothState.UNSUPPORTED
        return when (adapter.state) {
            BluetoothAdapter.STATE_OFF -> BluetoothState.POWERED_OFF
            BluetoothAdapter.STATE_TURNING_OFF, BluetoothAdapter.STATE_TURNING_ON -> BluetoothState.RESETTING
            BluetoothAdapter.STATE_ON -> BluetoothState.POWERED_ON
            else -> BluetoothState.UNKNOWN
        }
    }

    private fun rejectUnsupported(config: BotaConfig) {
        val unsupported = when {
            !config.backgroundSyncEnabled -> "backgroundSyncEnabled"
            config.wifiOnlyUpload -> "wifiOnlyUpload"
            config.debug -> "debug"
            else -> null
        }
        if (unsupported != null) {
            throw BotaSdkException.UnsupportedOperation("BotaConfig.$unsupported is not supported by the replacement SDK")
        }
    }
}

internal fun Throwable.toLegacyError(): Throwable = when (this) {
    is BotaSdkException -> this
    is BotaSDKError.Core -> when (code) {
        dev.bota.sdk.BotaErrorCode.NotConnected -> BotaSdkException.NotConnected("")
        else -> BotaSdkException.UnsupportedOperation(detail)
    }
    else -> BotaSdkException.UnsupportedOperation(message ?: "Bota SDK operation failed")
}
