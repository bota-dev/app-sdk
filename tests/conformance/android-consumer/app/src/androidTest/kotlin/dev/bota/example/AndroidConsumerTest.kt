package dev.bota.example

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.bota.sdk.BotaAndroidSDK
import dev.bota.sdk.BotaConfiguration
import dev.bota.sdk.BotaDeviceClient
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidConsumerTest {
    @Test
    fun publicCoordinateLoadsNativeFacade() = runBlocking {
        val client = BotaDeviceClient.shared
        client.configure(BotaConfiguration(ApplicationProvider.getApplicationContext()))
        assertEquals(BuildConfig.BOTA_CONSUMER_EXPECTED_VERSION, BotaAndroidSDK.version)
        assertTrue(client.devices.capabilities().asSet().isNotEmpty())
        client.destroy()
    }
}
