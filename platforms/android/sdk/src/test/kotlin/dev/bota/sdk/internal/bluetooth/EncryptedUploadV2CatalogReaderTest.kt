package dev.bota.sdk.internal.bluetooth

import dev.bota.sdk.internal.core.CodecCore
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.CoreModelMapper
import dev.bota.sdk.internal.core.EncryptedUploadV2CapabilityReader
import dev.bota.sdk.internal.core.toNativePacket
import dev.bota.sdk.internal.host.EncryptedUploadV2HostException
import java.util.UUID
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EncryptedUploadV2CatalogReaderTest {
    @Test
    fun subscribesToCatalogAndErrorsBeforeListAndReleasesBoth() = runTest {
        val driver = CatalogDriver()
        val mapper = mapper()
        val values = EncryptedUploadV2CatalogReader(driver, mapper).read("device", 9u)
        assertTrue(values.isEmpty())
        assertEquals(listOf("subscribe-list", "subscribe-errors", "write", "unsubscribe-errors", "unsubscribe-list"), driver.calls)
    }

    @Test
    fun malformedCatalogAndDeviceRejectionsCannotFallBack() = runTest {
        for (rejected in listOf(false, true)) {
            val driver = CatalogDriver(rejected)
            val mapper = mapper(malformed = !rejected)
            val error = runCatching { EncryptedUploadV2CatalogReader(driver, mapper).read("device", 9u) }.exceptionOrNull()
            assertTrue(error != null)
            if (rejected) assertEquals(17u, (error as EncryptedUploadV2HostException).errorCode)
            assertEquals(1, driver.calls.count { it == "write" })
            assertEquals(2, driver.calls.count { it.startsWith("unsubscribe") })
        }
    }

    @Test
    fun onlyExplicitCharacteristicAbsenceIsOptional() = runTest {
        val absent = EncryptedUploadV2CapabilityReader(
            read = { _, _, _ -> throw BluetoothCharacteristicNotFoundException() }, decode = { error("unused") },
        )
        assertNull(absent.readIfPresent("device"))
        val failed = EncryptedUploadV2CapabilityReader(
            read = { _, _, _ -> throw BluetoothTransportException(404, "read failed") }, decode = { error("unused") },
        )
        assertTrue(runCatching { failed.readIfPresent("device") }.isFailure)
        val malformed = EncryptedUploadV2CapabilityReader(
            read = { _, _, _ -> byteArrayOf(1) }, decode = { error("malformed") },
        )
        assertTrue(runCatching { malformed.readIfPresent("device") }.isFailure)
    }

    private fun mapper(malformed: Boolean = false) = CoreModelMapper(CodecCore(
        encode = { listOf(CoreField.Bytes(30, byteArrayOf(7))).toNativePacket(it.kind) },
        decode = { input ->
            when {
                input.kind == 0x0522 -> listOf(CoreField.Unsigned(61, 3u), CoreField.Unsigned(127, 0x4fu),
                    CoreField.Unsigned(128, 9u), CoreField.Unsigned(155, 9u), CoreField.Unsigned(97, 0x25u),
                    CoreField.Unsigned(133, 0u)).toNativePacket(input.kind)
                input.bytes(30)!!.isEmpty() -> emptyList<CoreField>().toNativePacket(input.kind)
                malformed -> error("Rust rejected malformed catalog")
                else -> listOf(CoreField.Unsigned(128, 9u), CoreField.Unsigned(85, 0u),
                    CoreField.Unsigned(148, 1u), CoreField.Bytes(123, ByteArray(32))).toNativePacket(input.kind)
            }
        },
    ))
}

private class CatalogDriver(private val reject: Boolean = false) : BluetoothDriver {
    val calls = mutableListOf<String>()
    private val channels = mutableMapOf<UUID, Channel<BluetoothNotification>>()
    private fun label(id: UUID): String = if (id == BotaBluetoothUUIDs.RecordingListV2) "list" else "errors"
    override suspend fun subscribe(peripheralId: String, serviceUuid: UUID, characteristicUuid: UUID): Flow<BluetoothNotification> {
        calls += "subscribe-${label(characteristicUuid)}"
        return Channel<BluetoothNotification>(Channel.UNLIMITED).also { channels[characteristicUuid] = it }.receiveAsFlow()
    }
    override suspend fun unsubscribe(peripheralId: String, serviceUuid: UUID, characteristicUuid: UUID) {
        calls += "unsubscribe-${label(characteristicUuid)}"
        channels.remove(characteristicUuid)?.close()
    }
    override suspend fun write(peripheralId: String, serviceUuid: UUID, characteristicUuid: UUID, value: ByteArray, withResponse: Boolean) {
        calls += "write"
        val channel = if (reject) BotaBluetoothUUIDs.RecordingTransferV2 else BotaBluetoothUUIDs.RecordingListV2
        channels.getValue(channel).send(BluetoothNotification(1, byteArrayOf(1)))
    }
    override suspend fun read(peripheralId: String, serviceUuid: UUID, characteristicUuid: UUID): ByteArray = error("unused")
    override suspend fun connectedAdvertisements(): List<BluetoothAdvertisement> = emptyList()
    override fun scan(allowDuplicates: Boolean): Flow<BluetoothAdvertisement> = emptyFlow()
    override suspend fun stopScan() = Unit
    override suspend fun connect(peripheralId: String) = Unit
    override suspend fun discoverServices(peripheralId: String) = Unit
    override fun maximumWriteLength(peripheralId: String): Int = 185
    override suspend fun disconnect(peripheralId: String) = Unit
    override fun close() = Unit
}
