package dev.bota.sdk.internal.bluetooth

import dev.bota.sdk.BotaOperation
import dev.bota.sdk.BotaSDKError
import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.jni.NativePacket
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothGattHostTest {
    @Test
    fun scanMergesConnectedDevicesAndDeduplicatesUnlessRequested() = runTest {
        val advertisement = BluetoothAdvertisement("device-1", "Bota Note", -42, "aabbccddeeff")
        val platform = FakeBluetoothPlatform(
            initialConnected = listOf(advertisement),
            scans = flowOf(advertisement, advertisement.copy(rssi = -41)),
        )
        val host = host(platform)

        val deduplicated = host.execute(effect(CoreEffectKind.BluetoothStartScan, allowDuplicates = false)).toList()
        assertEquals(1, deduplicated.size)

        val duplicated = host.execute(effect(CoreEffectKind.BluetoothStartScan, allowDuplicates = true)).toList()
        assertEquals(3, duplicated.size)
        assertEquals(listOf("device-1", "device-1", "device-1"), duplicated.map { it.fields.text(4) })
    }

    @Test
    fun permissionPreflightUsesTheAndroidApiContract() {
        val api30 = BluetoothPermissionChecker(30) { it == BluetoothPermissionChecker.FineLocation }
        api30.requireScan(BotaOperation.Discover)
        assertEquals(setOf(BluetoothPermissionChecker.FineLocation), api30.requiredPermissions)

        val api35 = BluetoothPermissionChecker(35) { false }
        val error = runCatching { api35.requireConnect(BotaOperation.Connect) }.exceptionOrNull()
        assertTrue(error is BotaSDKError.AuthorizationRequired)
        assertEquals(
            setOf(BluetoothPermissionChecker.BluetoothScan, BluetoothPermissionChecker.BluetoothConnect),
            api35.requiredPermissions,
        )
    }

    @Test
    fun manualSelectionPreemptsReconnectWithoutNameIdentity() = runTest {
        val platform = FakeBluetoothPlatform()
        val host = host(platform)
        host.execute(effect(CoreEffectKind.BluetoothConnect, operation = 6, peripheralId = "reconnect-id")).toList()

        host.execute(effect(CoreEffectKind.BluetoothConnect, operation = 5, peripheralId = "manual-id")).toList()

        assertEquals(listOf("reconnect-id"), platform.disconnected)
        assertEquals(listOf("reconnect-id", "manual-id"), platform.connected)
    }

    @Test
    fun driverSerializesPerDeviceButLetsOtherDevicesProgress() = runTest {
        val platform = FakeBluetoothPlatform()
        val driver = BluetoothGattDriver(platform, operationTimeoutMilliseconds = 2_000)
        driver.connect("a")
        driver.connect("b")
        val releaseA = CompletableDeferred<Unit>()
        platform.writeGate["a"] = releaseA
        val a = async { driver.write("a", Service, Characteristic, byteArrayOf(1), true) }
        val secondA = async { driver.read("a", Service, Characteristic) }
        val b = async { driver.write("b", Service, Characteristic, byteArrayOf(2), true) }

        b.await()
        assertFalse(secondA.isCompleted)
        releaseA.complete(Unit)
        a.await()
        secondA.await()
    }

    @Test
    fun connectNegotiatesMtuAndRejectsStatusTimeoutAndStaleGeneration() = runTest {
        val platform = FakeBluetoothPlatform()
        val driver = BluetoothGattDriver(platform, operationTimeoutMilliseconds = 20)
        driver.connect("device")
        assertEquals(listOf("connect:device:1", "mtu:device:1:517"), platform.calls.take(2))

        platform.nextStatus = 133
        assertTrue(runCatching { driver.discoverServices("device") }.exceptionOrNull() is BluetoothTransportException)

        platform.nextStatus = 0
        platform.staleGeneration = true
        assertTrue(runCatching { driver.read("device", Service, Characteristic) }.exceptionOrNull() is BluetoothTransportException)

        platform.staleGeneration = false
        platform.suspendReads = true
        assertTrue(runCatching { driver.read("device", Service, Characteristic) }.exceptionOrNull() is BluetoothTransportException)
    }

    @Test
    fun writesAndSubscriptionsUseApiSpecificCallsAndCccdOrder() = runTest {
        val platform = FakeBluetoothPlatform(apiLevel = 35)
        val driver = BluetoothGattDriver(platform)
        driver.connect("device")
        driver.discoverServices("device")

        driver.write("device", Service, Characteristic, byteArrayOf(1), true)
        val notifications = driver.subscribe("device", Service, Characteristic).toList()
        driver.unsubscribe("device", Service, Characteristic)

        assertTrue(platform.calls.contains("write:Api33"))
        assertEquals(
            listOf("notify:true", "descriptor:true", "notify:false", "descriptor:false"),
            platform.calls.filter { it.startsWith("notify:") || it.startsWith("descriptor:") },
        )
        assertTrue(notifications.single().value.contentEquals(byteArrayOf(7)))

        val legacy = FakeBluetoothPlatform(apiLevel = 30)
        val legacyDriver = BluetoothGattDriver(legacy)
        legacyDriver.connect("legacy")
        legacyDriver.write("legacy", Service, Characteristic, byteArrayOf(1), true)
        assertTrue(legacy.calls.contains("write:Legacy"))
    }

    @Test
    fun disconnectBypassesAndCancelsBlockedDeviceWork() = runTest {
        val platform = FakeBluetoothPlatform()
        val driver = BluetoothGattDriver(platform)
        driver.connect("device")
        val gate = CompletableDeferred<Unit>()
        platform.writeGate["device"] = gate
        val blocked = launch { runCatching { driver.write("device", Service, Characteristic, byteArrayOf(1), true) } }
        val queued = launch { runCatching { driver.read("device", Service, Characteristic) } }

        driver.disconnect("device")

        blocked.join()
        queued.join()
        assertEquals(listOf("device"), platform.disconnected)
    }
}

private class FakeBluetoothPlatform(
    override val apiLevel: Int = 35,
    private val initialConnected: List<BluetoothAdvertisement> = emptyList(),
    private val scans: Flow<BluetoothAdvertisement> = flowOf(),
) : AndroidBluetoothPlatform {
    val calls = mutableListOf<String>()
    val connected = mutableListOf<String>()
    val disconnected = mutableListOf<String>()
    val writeGate = mutableMapOf<String, CompletableDeferred<Unit>>()
    var nextStatus = 0
    var staleGeneration = false
    var suspendReads = false

    override suspend fun connectedAdvertisements(): List<BluetoothAdvertisement> = initialConnected
    override fun scan(allowDuplicates: Boolean): Flow<BluetoothAdvertisement> = scans
    override suspend fun stopScan() { calls += "stop-scan" }

    override suspend fun connect(peripheralId: String, generation: Long): GattResult<Unit> {
        calls += "connect:$peripheralId:$generation"
        connected += peripheralId
        return result(generation, Unit)
    }

    override suspend fun requestMtu(peripheralId: String, generation: Long, mtu: Int): GattResult<Int> {
        calls += "mtu:$peripheralId:$generation:$mtu"
        return result(generation, mtu)
    }

    override suspend fun discoverServices(peripheralId: String, generation: Long): GattResult<GattDiscovery> {
        calls += "discover:$peripheralId:$generation"
        return result(generation, GattDiscovery(setOf(Service), setOf(GattCharacteristic(Service, Characteristic))))
    }

    override suspend fun read(
        peripheralId: String,
        generation: Long,
        serviceUuid: UUID,
        characteristicUuid: UUID,
    ): GattResult<ByteArray> {
        if (suspendReads) CompletableDeferred<Unit>().await()
        calls += "read:$peripheralId"
        return result(generation, byteArrayOf(3))
    }

    override suspend fun write(
        peripheralId: String,
        generation: Long,
        serviceUuid: UUID,
        characteristicUuid: UUID,
        value: ByteArray,
        withResponse: Boolean,
        api: GattWriteApi,
    ): GattResult<Unit> {
        writeGate[peripheralId]?.await()
        calls += "write:${api.name}"
        return result(generation, Unit)
    }

    override suspend fun setNotification(
        peripheralId: String,
        generation: Long,
        serviceUuid: UUID,
        characteristicUuid: UUID,
        enabled: Boolean,
    ): GattResult<Unit> {
        calls += "notify:$enabled"
        return result(generation, Unit)
    }

    override suspend fun writeCccd(
        peripheralId: String,
        generation: Long,
        serviceUuid: UUID,
        characteristicUuid: UUID,
        enabled: Boolean,
        api: GattWriteApi,
    ): GattResult<Unit> {
        calls += "descriptor:$enabled"
        return result(generation, Unit)
    }

    override suspend fun notifications(
        peripheralId: String,
        generation: Long,
        serviceUuid: UUID,
        characteristicUuid: UUID,
    ): Flow<BluetoothNotification> = flowOf(BluetoothNotification(generation, byteArrayOf(7)))

    override suspend fun disconnect(peripheralId: String, generation: Long): GattResult<Unit> {
        disconnected += peripheralId
        return result(generation, Unit)
    }

    override fun close() = Unit

    private fun <T> result(generation: Long, value: T): GattResult<T> =
        GattResult(if (staleGeneration) generation - 1 else generation, nextStatus.also { nextStatus = 0 }, value)
}

private fun host(platform: AndroidBluetoothPlatform): BluetoothGattHost = BluetoothGattHost(
    BluetoothGattDriver(platform),
    BluetoothPermissionChecker(platform.apiLevel) { true },
)

private fun effect(
    kind: CoreEffectKind,
    operation: Int = 4,
    peripheralId: String? = null,
    allowDuplicates: Boolean = false,
): CoreEffect {
    val fields = buildList {
        peripheralId?.let { add(NativeField(4, NativePacket.FIELD_TYPE_UTF8, data = it.encodeToByteArray())) }
        if (kind == CoreEffectKind.BluetoothStartScan) {
            add(NativeField(2, NativePacket.FIELD_TYPE_BOOL, unsigned = if (allowDuplicates) 1 else 0))
        }
    }
    return CoreEffect.fromPacket(
        NativePacket(
            kind = kind.wireValue,
            operation = operation,
            requestIdBits = 1,
            cancellationHighBits = 2,
            cancellationLowBits = 3,
            fieldIds = fields.map(NativeField::id).toIntArray(),
            fieldTypes = fields.map(NativeField::type).toIntArray(),
            unsignedValues = fields.map(NativeField::unsigned).toLongArray(),
            signedValues = LongArray(fields.size),
            dataValues = fields.map(NativeField::data).toTypedArray(),
        ),
    )
}

private data class NativeField(val id: Int, val type: Int, val unsigned: Long = 0, val data: ByteArray? = null)
private fun List<dev.bota.sdk.internal.core.CoreField>.text(id: Int): String? =
    filterIsInstance<dev.bota.sdk.internal.core.CoreField.Text>().firstOrNull { it.id == id }?.value

private val Service = UUID.fromString("b07a0002-0000-1000-8000-00805f9b34fb")
private val Characteristic = UUID.fromString("b07a0002-0001-1000-8000-00805f9b34fb")
