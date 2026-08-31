package dev.bota.sdk

import dev.bota.sdk.internal.DeviceConnectionRegistry
import dev.bota.sdk.internal.DeviceRuntime
import dev.bota.sdk.internal.bluetooth.BotaBluetoothUUIDs
import dev.bota.sdk.internal.core.CoreCapabilities
import dev.bota.sdk.model.DeviceWiFiScanResult
import dev.bota.sdk.model.WiFiConfigResult
import dev.bota.sdk.model.WiFiConnectionStatus
import dev.bota.sdk.model.WiFiScanNetwork
import dev.bota.sdk.model.WiFiScanUpdate
import dev.bota.sdk.model.WiFiStatusInfo
import java.util.UUID
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class WiFiManagerTest {
    @Test
    fun configureWritesGrantBeforeSubscriptionAndCredentialsAfterSubscription() = runTest {
        val fixture = WiFiRuntimeFixture(
            notifications = mapOf(BotaBluetoothUUIDs.WifiStatus to listOf(byteArrayOf(0x00))),
        )
        val manager = WiFiManager()
        fixture.connect()
        manager.attach(fixture.runtime)

        val result = manager.configure(fixture.device, "Bota", "secret", "grant.test")

        assertEquals(WiFiConfigResult.Success, result)
        assertEquals(
            listOf(
                WiFiAction.Write(BotaBluetoothUUIDs.WifiGrant, "grant.test".encodeToByteArray().toList()),
                WiFiAction.Subscribe(BotaBluetoothUUIDs.WifiStatus),
                WiFiAction.Write(
                    BotaBluetoothUUIDs.WifiCredential,
                    (byteArrayOf(0x04) + "Bota".encodeToByteArray() + byteArrayOf(0x06) + "secret".encodeToByteArray()).toList(),
                ),
                WiFiAction.Unsubscribe(BotaBluetoothUUIDs.WifiStatus),
            ),
            fixture.actions,
        )
    }

    @Test
    fun disconnectSubscribesBeforeWritingForgetPacket() = runTest {
        val fixture = WiFiRuntimeFixture(
            notifications = mapOf(BotaBluetoothUUIDs.WifiStatus to listOf(byteArrayOf(0x00))),
        )
        val manager = WiFiManager()
        fixture.connect()
        manager.attach(fixture.runtime)

        val result = manager.disconnect(fixture.device)

        assertEquals(WiFiConfigResult.Success, result)
        assertEquals(
            listOf(
                WiFiAction.Subscribe(BotaBluetoothUUIDs.WifiStatus),
                WiFiAction.Write(BotaBluetoothUUIDs.WifiCredential, listOf(0)),
                WiFiAction.Unsubscribe(BotaBluetoothUUIDs.WifiStatus),
            ),
            fixture.actions,
        )
    }

    @Test
    fun readStatusUsesWiFiStatusCharacteristicAndSharedDecoder() = runTest {
        val fixture = WiFiRuntimeFixture(
            reads = mapOf(
                BotaBluetoothUUIDs.WifiStatus to
                    (byteArrayOf(0x02, 0x57, 0x04) + "Bota".encodeToByteArray()),
            ),
        )
        val manager = WiFiManager()
        fixture.connect()
        manager.attach(fixture.runtime)

        val result = manager.readStatus(fixture.device)

        assertEquals(WiFiStatusInfo(WiFiConnectionStatus.Connected, 87u.toUByte(), "Bota"), result)
        assertEquals(listOf(WiFiAction.Read(BotaBluetoothUUIDs.WifiStatus)), fixture.actions)
    }

    @Test
    fun scanSubscribesBeforeCommandAndIgnoresPendingUpdates() = runTest {
        val done = byteArrayOf(0x02, 0x02, 0x04) + "Bota".encodeToByteArray() +
            byteArrayOf(0x64, 0x03, 0x05) + "Guest".encodeToByteArray() + byteArrayOf(0x32, 0x02)
        val fixture = WiFiRuntimeFixture(
            notifications = mapOf(BotaBluetoothUUIDs.WifiScan to listOf(byteArrayOf(0x01), done)),
        )
        val manager = WiFiManager()
        fixture.connect()
        manager.attach(fixture.runtime)

        val result = manager.scanNetworks(fixture.device)

        assertEquals("Bota", result.currentSsid)
        assertEquals(listOf("Bota", "Guest"), result.networks.map(WiFiScanNetwork::ssid))
        assertEquals(
            listOf(
                WiFiAction.Subscribe(BotaBluetoothUUIDs.WifiScan),
                WiFiAction.Write(BotaBluetoothUUIDs.WifiScan, listOf(1)),
                WiFiAction.Unsubscribe(BotaBluetoothUUIDs.WifiScan),
            ),
            fixture.actions,
        )
    }

    @Test
    fun detachStopsActiveStatusObservationExactlyOnce() = runTest {
        val fixture = WiFiRuntimeFixture(openSubscriptions = setOf(BotaBluetoothUUIDs.WifiStatus))
        val manager = WiFiManager()
        fixture.connect()
        manager.attach(fixture.runtime)

        val collector = launch { manager.statusUpdates(fixture.device).collect {} }
        fixture.waitFor(WiFiAction.Subscribe(BotaBluetoothUUIDs.WifiStatus))
        manager.detach()
        collector.join()

        assertEquals(1, fixture.actions.count { it == WiFiAction.Unsubscribe(BotaBluetoothUUIDs.WifiStatus) })
    }
}

private sealed interface WiFiAction {
    data class Read(val characteristic: UUID) : WiFiAction
    data class Write(val characteristic: UUID, val value: List<Byte>) : WiFiAction
    data class Subscribe(val characteristic: UUID) : WiFiAction
    data class Unsubscribe(val characteristic: UUID) : WiFiAction
}

private class WiFiRuntimeFixture(
    private val reads: Map<UUID, ByteArray> = emptyMap(),
    private val notifications: Map<UUID, List<ByteArray>> = emptyMap(),
    private val openSubscriptions: Set<UUID> = emptySet(),
) {
    val device = SecureRuntimeFixture().device
    val connection = DeviceConnectionRegistry()
    val actions = mutableListOf<WiFiAction>()
    val runtime = DeviceRuntime(
        engine = SecureWorkflowRunner(),
        capabilities = CoreCapabilities.Bluetooth + CoreCapabilities.Timer,
        authorize = {},
        disconnect = {},
        readStatus = { error("unused") },
        statusUpdates = { error("unused") },
        stopStatusUpdates = {},
        decodeStatus = { error("unused") },
        closeResources = {},
        connection = connection,
        directRead = { _, _, characteristic ->
            actions += WiFiAction.Read(characteristic)
            reads[characteristic]?.copyOf() ?: byteArrayOf()
        },
        directWrite = { _, _, characteristic, value ->
            actions += WiFiAction.Write(characteristic, value.toList())
        },
        directSubscribe = { _, _, characteristic ->
            actions += WiFiAction.Subscribe(characteristic)
            flow {
                notifications[characteristic].orEmpty().forEach { emit(it.copyOf()) }
                if (characteristic in openSubscriptions) awaitCancellation()
            }
        },
        directUnsubscribe = { _, _, characteristic -> actions += WiFiAction.Unsubscribe(characteristic) },
        parseWiFiConfigResult = { WiFiConfigResult.Success },
        parseWiFiStatusInfo = {
            WiFiStatusInfo(WiFiConnectionStatus.Connected, 87u.toUByte(), "Bota")
        },
        parseWiFiScanResult = {
            if (it.first() == 1.toByte()) {
                WiFiScanUpdate.Pending(1u)
            } else {
                WiFiScanUpdate.Done(
                    DeviceWiFiScanResult(
                        listOf(
                            WiFiScanNetwork("Bota", 100u, isCurrent = true, isOpen = true),
                            WiFiScanNetwork("Guest", 50u, isCurrent = false, isOpen = true),
                        ),
                        "Bota",
                    ),
                )
            }
        },
        createWiFiGrantPacket = String::encodeToByteArray,
        createWiFiCredentialPacket = { ssid, password ->
            if (ssid.isEmpty() && password.isEmpty()) {
                byteArrayOf(0)
            } else {
                byteArrayOf(ssid.encodeToByteArray().size.toByte()) + ssid.encodeToByteArray() +
                    byteArrayOf(password.encodeToByteArray().size.toByte()) + password.encodeToByteArray()
            }
        },
        createWiFiScanCommand = { byteArrayOf(1) },
    )

    fun connect() = connection.set(device)

    suspend fun waitFor(action: WiFiAction) {
        while (action !in actions) kotlinx.coroutines.yield()
    }
}
