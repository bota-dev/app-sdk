package dev.bota.sdk.reactnative

import dev.bota.sdk.BotaDeviceClient
import dev.bota.sdk.FirmwareImage
import dev.bota.sdk.model.ConnectedDevice
import dev.bota.sdk.model.FirmwareUpdateProgress
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import okhttp3.Request

internal interface BotaDeviceSDKAndroidOTAClient {
    fun updateFirmware(
        device: ConnectedDevice,
        image: FirmwareImage,
    ): Flow<FirmwareUpdateProgress>

    suspend fun cancelCurrentOperation()
}

internal class BotaDeviceSDKSharedAndroidOTAClient(
    private val client: BotaDeviceClient = BotaDeviceClient.shared,
) : BotaDeviceSDKAndroidOTAClient {
    override fun updateFirmware(
        device: ConnectedDevice,
        image: FirmwareImage,
    ): Flow<FirmwareUpdateProgress> = client.ota.updateFirmware(device, image)

    override suspend fun cancelCurrentOperation() {
        client.ota.cancelCurrentOperation()
    }
}

internal class BotaDeviceSDKAndroidOTA(
    private val client: BotaDeviceSDKAndroidOTAClient = BotaDeviceSDKSharedAndroidOTAClient(),
) {
    suspend fun updateFirmware(
        device: ConnectedDevice,
        version: String,
        sizeBytes: UInt,
        crc32: UInt,
        url: String,
        onProgress: (FirmwareUpdateProgress) -> Unit,
    ) {
        val image = FirmwareImage(
            version = version,
            sizeBytes = sizeBytes,
            crc32 = crc32,
            downloadId = UUID.randomUUID().leastSignificantBits.toULong(),
            request = Request.Builder().url(url).get().build(),
        )
        client.updateFirmware(device, image).collect(onProgress)
    }

    suspend fun cancelAll() {
        runCatching { client.cancelCurrentOperation() }
    }
}
