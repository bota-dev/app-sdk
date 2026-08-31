package dev.bota.sdk

import dev.bota.sdk.internal.DeviceRuntime
import dev.bota.sdk.internal.runCleanupActions
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

public class BotaDeviceClient internal constructor() {
    public val devices: DeviceManager = DeviceManager()
    public val provisioning: ProvisioningManager = ProvisioningManager()
    public val factoryReset: FactoryResetManager = FactoryResetManager()

    private val lifecycle = Mutex()
    private var runtime: DeviceRuntime? = null

    public suspend fun configure(configuration: BotaConfiguration) {
        lifecycle.withLock {
            if (runtime != null) return
            val configured = configuration.runtimeFactory()
            runtime = configured
            devices.attach(configured)
            provisioning.attach(configured)
            factoryReset.attach(configured)
        }
    }

    public suspend fun destroy() {
        lifecycle.withLock {
            val configured = runtime ?: return
            try {
                runCleanupActions(
                    { factoryReset.detach() },
                    { provisioning.detach() },
                    { devices.detach() },
                    { configured.close() },
                )
            } finally {
                runtime = null
            }
        }
    }

    public companion object {
        @JvmField
        public val shared: BotaDeviceClient = BotaDeviceClient()
    }
}
