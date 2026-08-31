package dev.bota.sdk.internal.host

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import java.io.File
import java.util.UUID
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
internal class AtomicFilePersistenceHostTest {
    @Test
    fun atomicReplacementRestartAndResetBindingSurviveOnDevice() {
        runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.noBackupFilesDir, "host-test-${UUID.randomUUID()}")
        val store = AtomicFileJournalStore(root)
        val first = AtomicFilePersistenceHost(store)
        first.execute(
            androidHostEffect(
                CoreEffectKind.PersistenceSaveCheckpoint,
                CoreField.Bytes(28, byteArrayOf(1, 2, 3)),
            ),
        ).toList()

        val interrupted = store.startWrite("workflow-checkpoint.bin")
        interrupted.write(byteArrayOf(9, 9, 9))
        store.failWrite("workflow-checkpoint.bin", interrupted)

        first.registerFactoryReset("command-1", 18u)
        first.execute(
            androidHostEffect(
                CoreEffectKind.PersistenceSaveFactoryResetResult,
                CoreField.Text(22, "command-1"),
                CoreField.Unsigned(24, 0u),
                CoreField.Unsigned(25, 3u),
            ),
        ).toList()
        first.execute(
            androidHostEffect(
                CoreEffectKind.PersistenceSaveConnectionIdentity,
                CoreField.Text(3, "SERIAL-1"),
                CoreField.Text(4, "peripheral-1"),
                CoreField.Text(5, "Bota Note"),
            ),
        ).toList()

        val recreated = AtomicFilePersistenceHost(AtomicFileJournalStore(root))
        val checkpoint = recreated.execute(androidHostEffect(CoreEffectKind.PersistenceLoadCheckpoint)).toList().single()

        assertArrayEquals(byteArrayOf(1, 2, 3), checkpoint.androidBytes(28))
        assertEquals(PersistedFactoryResetResult("command-1", 0u, 3u, 18u), recreated.loadFactoryResetResult())
        assertNoPersistedCredentialMaterial(root)

        recreated.execute(
            androidHostEffect(
                CoreEffectKind.PersistenceDeleteFactoryResetResult,
                CoreField.Text(22, "command-1"),
            ),
        ).toList()
        assertNull(recreated.loadFactoryResetResult())
            root.deleteRecursively()
        }
    }
}
