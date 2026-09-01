package dev.bota.example

import android.content.Context
import dev.bota.sdk.BotaConfiguration
import dev.bota.sdk.BotaDeviceClient
import dev.bota.sdk.DeviceReconnectHint
import dev.bota.sdk.FirmwareImage
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.DeviceConnectionSettings
import dev.bota.sdk.model.DeviceRecording
import dev.bota.sdk.model.DiscoveredDevice
import dev.bota.sdk.model.ProvisioningMaterial
import java.util.Base64

public object AndroidConsumer {
    public suspend fun configureAndDestroy(context: Context) {
        val client = BotaDeviceClient.shared
        client.configure(BotaConfiguration(context))
        client.devices.capabilities()
        client.destroy()
    }

    @Suppress("UNUSED_PARAMETER")
    public suspend fun typeCheckEveryWorkflow(
        client: BotaDeviceClient,
        discovered: DiscoveredDevice,
        connected: ConnectedDevice,
        recording: DeviceRecording,
        settings: DeviceConnectionSettings,
        image: FirmwareImage,
    ) {
        client.devices.startScan()
        client.devices.connect(connected.serialNumber, discovered)
        client.devices.reconnect(connected.serialNumber, DeviceReconnectHint(storedPeripheralId = connected.id))
        client.devices.connectionUpdates()
        client.devices.readStatus()
        client.devices.statusUpdates()
        client.provisioning.provision(connected) {
            ProvisioningMaterial("endpoint".toByteArray(), "token".toByteArray(), connected.mtu.toULong())
        }
        client.provisioning.writeConnectionSettings(settings, connected)
        client.provisioning.deprovision(
            connected,
            Base64.getEncoder().encodeToString(byteArrayOf(1)),
        )
        val recordingGrant = Base64.getEncoder().encodeToString(byteArrayOf(1))
        client.controls.requestStartRecording(connected, recordingGrant)
        client.controls.requestStopRecording(connected, recordingGrant)
        client.controls.readRecordingState(connected)
        client.controls.recordingStateUpdates(connected)
        client.factoryReset.factoryReset(connected, "command", 1u) { byteArrayOf(1) }
        client.factoryReset.resumePendingFactoryReset(connected, 1u)
        client.recordings.listRecordings(connected)
        client.recordings.syncRecording(connected, recording)
        client.recordings.observeUploadOwnership(connected, recording.uuid, "upload", "destination")
        client.ota.updateFirmware(connected, image)
        client.logs.streamLogs(connected)
        client.devices.cancelCurrentOperation()
        client.provisioning.cancelCurrentOperation()
        client.factoryReset.cancelCurrentOperation()
        client.recordings.cancelCurrentOperation()
        client.ota.cancelCurrentOperation()
        client.logs.stop()
        client.devices.disconnect()
        client.destroy()
    }
}
