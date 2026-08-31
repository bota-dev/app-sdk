package dev.bota.sdk

import android.content.Context
import dev.bota.sdk.internal.DeviceRuntime
import java.io.File
import okhttp3.OkHttpClient

public class BotaConfiguration internal constructor(
    internal val runtimeFactory: suspend () -> DeviceRuntime,
) {
    public constructor(
        context: Context,
        networkClient: OkHttpClient = OkHttpClient(),
        storageDirectory: File? = null,
    ) : this(runtimeFactory(context, networkClient, storageDirectory))

    private companion object {
        fun runtimeFactory(
            context: Context,
            networkClient: OkHttpClient,
            storageDirectory: File?,
        ): suspend () -> DeviceRuntime {
            val applicationContext = requireNotNull(context.applicationContext) {
                "BotaConfiguration requires a Context with an application context"
            }
            return { DeviceRuntime.create(applicationContext, networkClient, storageDirectory) }
        }
    }
}
