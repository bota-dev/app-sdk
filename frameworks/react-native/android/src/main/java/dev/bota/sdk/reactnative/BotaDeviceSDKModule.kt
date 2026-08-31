package dev.bota.sdk.reactnative

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.module.annotations.ReactModule
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
        launch(promise) { lifecycle.destroy() }
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

    companion object {
        const val NAME = NativeBotaDeviceSDKSpec.NAME
        private const val ERROR_CODE = "android_sdk_error"
    }
}
