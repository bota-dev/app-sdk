package dev.bota.sdk

import org.junit.Assert.assertEquals
import org.junit.Test

internal class PackageSmokeTest {
    @Test
    fun publicVersionComesFromTheFamilyAuthority() {
        assertEquals(System.getProperty("bota.test.sdkVersion"), BotaAndroidSDK.version)
        assertEquals("dev.bota", BotaAndroidSDK.mavenGroup)
        assertEquals("bota-android-sdk", BotaAndroidSDK.mavenArtifact)
    }
}
