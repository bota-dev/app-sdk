package dev.bota.sdk

import dev.bota.sdk.internal.DeviceRuntime
import dev.bota.sdk.internal.runCleanupActions
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

public class BotaDeviceClient internal constructor() {
    public val devices: DeviceManager = DeviceManager()
    public val controls: DeviceControlManager = DeviceControlManager()
    public val wifi: WiFiManager = WiFiManager()
    public val provisioning: ProvisioningManager = ProvisioningManager()
    public val factoryReset: FactoryResetManager = FactoryResetManager()
    public val recordings: RecordingManager = RecordingManager()
    public val ota: OTAManager = OTAManager()
    public val logs: DeviceLogManager = DeviceLogManager()

    private val lifecycle = Mutex()
    private var runtime: DeviceRuntime? = null

    public suspend fun configure(configuration: BotaConfiguration) {
        lifecycle.withLock {
            if (runtime != null) return
            val configured = configuration.runtimeFactory()
            runtime = configured
            devices.attach(configured)
            controls.attach(configured)
            wifi.attach(configured)
            provisioning.attach(configured)
            factoryReset.attach(configured)
            recordings.attach(configured)
            ota.attach(configured)
            logs.attach(configured)
        }
    }

    public suspend fun destroy() {
        lifecycle.withLock {
            val configured = runtime ?: return
            try {
                runCleanupActions(
                    { logs.detach() },
                    { ota.detach() },
                    { recordings.detach() },
                    { wifi.detach() },
                    { factoryReset.detach() },
                    { provisioning.detach() },
                    { controls.detach() },
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
