package dev.bota.sdk.reactnative

import dev.bota.sdk.FirmwareImage
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.ConnectionState
import dev.bota.sdk.model.DeviceType
import dev.bota.sdk.model.FirmwareUpdatePhase
import dev.bota.sdk.model.FirmwareUpdateProgress
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BotaDeviceSDKAndroidOTATest {
    @Test
    fun firmwareDownloadAndTransferStayNative() = runTest {
        val client = TestAndroidOTAClient()
        val ota = BotaDeviceSDKAndroidOTA(client)
        val progress = mutableListOf<FirmwareUpdateProgress>()

        ota.updateFirmware(
            device = ConnectedDevice(
                id = "selected",
                serialNumber = "EVFXXW67KP",
                deviceType = DeviceType.BotaPin,
                firmwareVersion = "1.0.11",
                isProvisioned = true,
                connectionState = ConnectionState.Connected,
                mtu = 247,
            ),
            version = "1.0.12",
            sizeBytes = 1_024_000u,
            crc32 = 0x1234_5678u,
            url = "https://firmware.bota.dev/update.ufw",
            onProgress = progress::add,
        )

        val image = requireNotNull(client.image)
        assertEquals("1.0.12", image.version)
        assertEquals(1_024_000u, image.sizeBytes)
        assertEquals(0x1234_5678u, image.crc32)
        assertEquals("https://firmware.bota.dev/update.ufw", image.request.url.toString())
        assertEquals(
            listOf(
                FirmwareUpdateProgress(FirmwareUpdatePhase.Downloading, 512_000u, 1_024_000u),
                FirmwareUpdateProgress(FirmwareUpdatePhase.Complete, 1_024_000u, 1_024_000u),
            ),
            progress,
        )
        ota.cancelAll()
        assertTrue(client.cancelled)
    }

    private class TestAndroidOTAClient : BotaDeviceSDKAndroidOTAClient {
        var image: FirmwareImage? = null
        var cancelled = false

        override fun updateFirmware(
            device: ConnectedDevice,
            image: FirmwareImage,
        ): Flow<FirmwareUpdateProgress> {
            this.image = image
            return flowOf(
                FirmwareUpdateProgress(FirmwareUpdatePhase.Downloading, 512_000u, 1_024_000u),
                FirmwareUpdateProgress(FirmwareUpdatePhase.Complete, 1_024_000u, 1_024_000u),
            )
        }

        override suspend fun cancelCurrentOperation() {
            cancelled = true
        }
    }
}
