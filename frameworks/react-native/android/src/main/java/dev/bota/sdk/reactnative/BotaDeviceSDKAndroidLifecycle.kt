package dev.bota.sdk.reactnative

import android.content.Context
import dev.bota.sdk.BotaConfiguration
import dev.bota.sdk.BotaDeviceClient
import java.io.File
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal interface BotaDeviceSDKAndroidClient {
    suspend fun configure(storageDirectory: File?)

    suspend fun destroy()
}

internal class BotaDeviceSDKSharedAndroidClient(
    context: Context,
    private val client: BotaDeviceClient = BotaDeviceClient.shared,
) : BotaDeviceSDKAndroidClient {
    private val applicationContext = context.applicationContext

    override suspend fun configure(storageDirectory: File?) {
        client.configure(
            BotaConfiguration(
                context = applicationContext,
                storageDirectory = storageDirectory,
            ),
        )
    }

    override suspend fun destroy() {
        client.destroy()
    }
}

internal data class BotaDeviceSDKAndroidCapabilities(
    val backgroundReconnect: Boolean,
    val backgroundScan: Boolean,
    val bluetooth: Boolean,
    val nativeFileTransfer: Boolean,
    val platform: String,
) {
    companion object {
        val current = BotaDeviceSDKAndroidCapabilities(
            backgroundReconnect = false,
            backgroundScan = false,
            bluetooth = true,
            nativeFileTransfer = true,
            platform = "android",
        )
    }
}

internal class BotaDeviceSDKAndroidLifecycle(
    private val client: BotaDeviceSDKAndroidClient,
) {
    private enum class Phase(val externalName: String) {
        UNINITIALIZED("uninitialized"),
        INITIALIZING("initializing"),
        READY("ready"),
        ERROR("error"),
        DESTROYING("uninitialized"),
    }

    private val lifecycle = Mutex()

    @Volatile
    private var phase = Phase.UNINITIALIZED

    suspend fun configure(storageDirectory: File?) {
        lifecycle.withLock {
            if (phase == Phase.READY) return
            phase = Phase.INITIALIZING
            try {
                client.configure(storageDirectory)
                phase = Phase.READY
            } catch (error: Throwable) {
                phase = Phase.ERROR
                throw error
            }
        }
    }

    suspend fun destroy() {
        lifecycle.withLock {
            if (phase == Phase.UNINITIALIZED) return
            phase = Phase.DESTROYING
            try {
                client.destroy()
            } finally {
                phase = Phase.UNINITIALIZED
            }
        }
    }

    fun state(): String = phase.externalName

    fun capabilities(): BotaDeviceSDKAndroidCapabilities =
        BotaDeviceSDKAndroidCapabilities.current
}
