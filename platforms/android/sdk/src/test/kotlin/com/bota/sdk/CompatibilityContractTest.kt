@file:Suppress("DEPRECATION")

package com.bota.sdk

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test

class CompatibilityContractTest {
    @Test
    fun rawProtocolHelpersFailWithTheDocumentedStableError() {
        val error = assertThrows(BotaSdkException.UnsupportedOperation::class.java) {
            BotaProtocol.parseRecordingEntry(ByteArray(24))
        }

        assertEquals("Raw protocol helpers moved to the Rust core", error.detail)
    }

    @Test
    fun versionConstantUsesTheSynchronizedSdkVersion() {
        assertEquals(System.getProperty("bota.test.sdkVersion"), BotaSdkVersion.current)
    }

    @Test
    fun unsupportedLegacyConfigurationIsRejectedBeforeNativeStartup() {
        val error = assertThrows(BotaSdkException.UnsupportedOperation::class.java) {
            runTest { BotaClient().configure(BotaConfig(debug = true)) }
        }

        assertEquals("BotaConfig.debug is not supported by the replacement SDK", error.detail)
    }

    @Test
    fun callerSuppliedTransportHasAStableMigrationError() {
        val error = assertThrows(BotaSdkException.UnsupportedOperation::class.java) {
            runTest { BotaClient(FakeTransport).configure() }
        }

        assertEquals("Caller-supplied BluetoothTransport is not supported by the replacement SDK", error.detail)
    }

    @Test
    fun synchronousDestroyIsImmediateAndIdempotent() {
        val client = BotaClient()

        client.destroy()
        client.destroy()

        assertFalse(client.isInitialized)
        assertEquals(SdkState.UNINITIALIZED, client.state)
        assertSame(BotaClient.shared, BotaClient.shared)
    }

    private object FakeTransport : BluetoothTransport {
        override suspend fun bluetoothState(): BluetoothState = BluetoothState.POWERED_ON
        override fun scan(options: ScanOptions): Flow<DiscoveredDevice> = emptyFlow()
        override fun stopScan(): Unit = Unit
        override suspend fun connect(device: DiscoveredDevice): ConnectedDevice = error("unused")
        override suspend fun disconnect(device: ConnectedDevice): Unit = Unit
        override fun isConnected(deviceId: String): Boolean = false
        override suspend fun read(deviceId: String, service: String, characteristic: String): ByteArray = byteArrayOf()
        override suspend fun write(
            deviceId: String,
            service: String,
            characteristic: String,
            data: ByteArray,
            withResponse: Boolean,
        ): Unit = Unit
        override fun notifications(deviceId: String, service: String, characteristic: String): Flow<ByteArray> = emptyFlow()
    }
}
