package dev.bota.sdk.internal.host

import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.HostEventKind
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JournalStoreContractTest {
    @Test
    fun checkpointAndResetResultSurviveHostRecreationAndRejectStaleDeletion() = runTest {
        val store = MemoryJournalStore()
        val first = AtomicFilePersistenceHost(store)
        first.execute(
            hostEffect(
                CoreEffectKind.PersistenceSaveCheckpoint,
                CoreField.Bytes(28, byteArrayOf(1, 2, 3)),
            ),
        ).toList()
        first.registerFactoryReset("reset-1", 12u)
        first.execute(
            hostEffect(
                CoreEffectKind.PersistenceSaveFactoryResetResult,
                CoreField.Text(22, "reset-1"),
                CoreField.Unsigned(24, 7u),
                CoreField.Unsigned(25, 42u),
            ),
        ).toList()

        val recreated = AtomicFilePersistenceHost(store)
        val checkpoint = recreated.execute(hostEffect(CoreEffectKind.PersistenceLoadCheckpoint)).toList().single()
        val result = recreated.loadFactoryResetResult()

        assertArrayEquals(byteArrayOf(1, 2, 3), checkpoint.bytes(28))
        assertEquals(PersistedFactoryResetResult("reset-1", 7u, 42u, 12u), result)

        val stale = runCatching {
            recreated.execute(
                hostEffect(
                    CoreEffectKind.PersistenceDeleteFactoryResetResult,
                    CoreField.Text(22, "reset-2"),
                ),
            ).toList()
        }
        assertTrue(stale.isFailure)
        assertEquals(result, recreated.loadFactoryResetResult())

        recreated.execute(
            hostEffect(
                CoreEffectKind.PersistenceDeleteFactoryResetResult,
                CoreField.Text(22, "reset-1"),
            ),
        ).toList()
        assertNull(recreated.loadFactoryResetResult())
    }

    @Test
    fun connectionIdentityPersistsOnlyReconnectMetadata() = runTest {
        val store = MemoryJournalStore()
        val host = AtomicFilePersistenceHost(store)

        val event = host.execute(
            hostEffect(
                CoreEffectKind.PersistenceSaveConnectionIdentity,
                CoreField.Text(3, "SERIAL-1"),
                CoreField.Text(4, "peripheral-1"),
                CoreField.Text(5, "Bota Pin"),
                CoreField.Text(6, "001122334455"),
                CoreField.Signed(7, -45),
            ),
        ).toList().single()

        assertEquals(HostEventKind.ConnectionIdentitySaved, event.kind)
        val persisted = store.values.values.flatMap(ByteArray::asIterable).toByteArray().decodeToString()
        assertTrue(persisted.contains("SERIAL-1"))
        listOf("https://", "Authorization:", "dtok_", "sk_live_", "/storage/").forEach {
            assertFalse(it, persisted.contains(it))
        }
    }

    @Test
    fun materialRegistrationsAreOneShotAndReturnOnlyPreparedFields() = runTest {
        val host = ApplicationMaterialHost()
        host.registerProvisioning("material-1") { request ->
            assertEquals("SERIAL-1", request.serialNumber)
            assertArrayEquals(ByteArray(16) { 0x11 }, request.nonce)
            ProvisioningMaterial("api".encodeToByteArray(), "token".encodeToByteArray(), 185u)
        }
        val effect = hostEffect(
            CoreEffectKind.PrepareProvisioning,
            CoreField.Text(12, "material-1"),
            CoreField.Text(3, "SERIAL-1"),
            CoreField.Bytes(41, ByteArray(16) { 0x11 }),
            CoreField.Bytes(42, ByteArray(64) { 0x22 }),
        )

        val event = host.execute(effect).toList().single()

        assertEquals(185uL, event.unsigned(57))
        assertArrayEquals("token".encodeToByteArray(), event.bytes(56))
        assertTrue(runCatching { host.execute(effect).toList() }.isFailure)
    }
}

private class MemoryJournalStore : JournalStore {
    val values = mutableMapOf<String, ByteArray>()

    override suspend fun read(name: String): ByteArray? = values[name]?.copyOf()

    override suspend fun write(name: String, value: ByteArray) {
        values[name] = value.copyOf()
    }

    override suspend fun delete(name: String) {
        values.remove(name)
    }
}

