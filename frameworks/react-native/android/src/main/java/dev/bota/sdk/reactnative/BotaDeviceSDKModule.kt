package dev.bota.sdk.reactnative

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.module.annotations.ReactModule
import dev.bota.sdk.DeviceReconnectHint
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

@ReactModule(name = NativeBotaDeviceSDKSpec.NAME)
internal class BotaDeviceSDKModule(
    reactContext: ReactApplicationContext,
    private val lifecycle: BotaDeviceSDKAndroidLifecycle =
        BotaDeviceSDKAndroidLifecycle(BotaDeviceSDKSharedAndroidClient(reactContext)),
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) : NativeBotaDeviceSDKSpec(reactContext) {
    private val devices = BotaDeviceSDKAndroidDevices(BotaDeviceSDKSharedAndroidDeviceClient(), scope)
    private val security = BotaDeviceSDKAndroidSecurity()

    override fun configure(configuration: ReadableMap, promise: Promise) {
        val storageDirectory =
            if (configuration.hasKey("applicationSupportDirectory") &&
                !configuration.isNull("applicationSupportDirectory")
            ) {
                configuration.getString("applicationSupportDirectory")?.let(::File)
            } else {
                null
            }
        launch(promise) { lifecycle.configure(storageDirectory) }
    }

    override fun destroy(promise: Promise) {
        launch(promise) {
            security.cancelAll()
            devices.stopAll()
            lifecycle.destroy()
        }
    }

    override fun startScan(timeoutMs: Double, allowDuplicates: Boolean, promise: Promise) {
        launch(promise) {
            devices.startScan(timeoutMs.toTimeoutMilliseconds(), allowDuplicates) {
                emitOnDeviceDiscovered(it.toWritableMap())
            }
        }
    }

    override fun stopScan(promise: Promise) {
        launch(promise) { devices.stopScan() }
    }

    override fun connectSelected(device: ReadableMap, promise: Promise) {
        launchValue(promise) { devices.connect(device.toDiscoveredDevice()).toWritableMap() }
    }

    override fun reconnect(serialNumber: String, options: ReadableMap, promise: Promise) {
        launchValue(promise) {
            devices.reconnect(
                serialNumber,
                DeviceReconnectHint(
                    scanTimeoutMilliseconds = options.getDouble("scanTimeoutMs").toTimeoutMilliseconds(),
                    connectionTimeoutMilliseconds = options
                        .getDouble("connectionTimeoutMs")
                        .toTimeoutMilliseconds(),
                ),
            ).toWritableMap()
        }
    }

    override fun disconnect(promise: Promise) {
        launch(promise) { devices.disconnect() }
    }

    override fun readStatus(promise: Promise) {
        launchValue(promise) { devices.readStatus().toWritableMap() }
    }

    override fun startStatusUpdates(promise: Promise) {
        launch(promise) {
            devices.startStatusUpdates {
                emitOnDeviceStatusUpdated(it.toWritableMap())
            }
        }
    }

    override fun stopStatusUpdates(promise: Promise) {
        launch(promise) { devices.stopStatusUpdates() }
    }

    override fun provision(device: ReadableMap, promise: Promise) {
        launch(promise) {
            security.provision(device.toConnectedDevice()) {
                emitOnProvisioningMaterialRequested(it.toWritableMap())
            }
        }
    }

    override fun deprovision(device: ReadableMap, promise: Promise) {
        launch(promise) { security.deprovision(device.toConnectedDevice()) }
    }

    override fun resolveProvisioningMaterial(
        requestId: String,
        material: ReadableMap,
        promise: Promise,
    ) {
        launch(promise) {
            security.resolveProvisioningMaterial(
                requestId = requestId,
                apiEndpoint = material.getString("apiEndpoint")
                    ?: error("provisioning API endpoint is required"),
                deviceToken = material.getString("deviceToken")
                    ?: error("provisioning device token is required"),
                mtu = material.getDouble("mtu").toUnsignedInteger(),
            )
        }
    }

    override fun rejectApplicationMaterial(requestId: String, message: String, promise: Promise) {
        launch(promise) { security.rejectApplicationMaterial(requestId, message) }
    }

    override fun getCapabilities(promise: Promise) {
        val capabilities = lifecycle.capabilities()
        promise.resolve(
            Arguments.createMap().apply {
                putBoolean("backgroundReconnect", capabilities.backgroundReconnect)
                putBoolean("backgroundScan", capabilities.backgroundScan)
                putBoolean("bluetooth", capabilities.bluetooth)
                putBoolean("nativeFileTransfer", capabilities.nativeFileTransfer)
                putString("platform", capabilities.platform)
            },
        )
    }

    override fun getState(promise: Promise) {
        promise.resolve(lifecycle.state())
    }

    override fun invalidate() {
        scope.launch {
            try {
                security.cancelAll()
                devices.stopAll()
                lifecycle.destroy()
            } finally {
                scope.cancel()
            }
        }
        super.invalidate()
    }

    private fun launch(promise: Promise, operation: suspend () -> Unit) {
        scope.launch {
            try {
                operation()
                promise.resolve(null)
            } catch (error: Throwable) {
                promise.reject(ERROR_CODE, error.message ?: "Bota Android SDK operation failed", error)
            }
        }
    }

    private fun launchValue(promise: Promise, operation: suspend () -> Any) {
        scope.launch {
            try {
                promise.resolve(operation())
            } catch (error: Throwable) {
                promise.reject(ERROR_CODE, error.message ?: "Bota Android SDK operation failed", error)
            }
        }
    }

    companion object {
        const val NAME = NativeBotaDeviceSDKSpec.NAME
        private const val ERROR_CODE = "android_sdk_error"
    }
}

private fun Double.toTimeoutMilliseconds(): ULong {
    require(isFinite() && this >= 0 && this <= Long.MAX_VALUE.toDouble()) {
        "timeout must be a finite non-negative number"
    }
    return toLong().toULong()
}

private fun Double.toUnsignedInteger(): ULong {
    require(isFinite() && this >= 0 && this <= 9_007_199_254_740_991.0 && this % 1.0 == 0.0) {
        "value must be a finite non-negative integer"
    }
    return toLong().toULong()
}
