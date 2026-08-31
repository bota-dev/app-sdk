package dev.bota.sdk.internal.host

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import java.io.File
import java.security.KeyStore
import java.util.UUID
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
internal class KeystoreHostTest {
    @Test
    fun ciphertextSurvivesRecreationButKeyIsNonExportable() {
        runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.noBackupFilesDir, "secret-test-${UUID.randomUUID()}")
        val alias = "dev.bota.test.${UUID.randomUUID()}"
        val secret = "dtok_secret-value".encodeToByteArray()
        val first = AndroidKeystoreSecureStorageHost(context, alias, root)
        first.execute(
            androidHostEffect(
                CoreEffectKind.SecureStorageWrite,
                CoreField.Text(29, "device-token"),
                CoreField.Bytes(30, secret),
            ),
        ).toList()

        val ciphertext = first.ciphertextFile("device-token").readBytes()
        assertFalse(ciphertext.containsSlice(secret))
        assertNoPersistedCredentialMaterial(root)
        val key = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey(alias, null)
        assertNull(key.encoded)

        val recreated = AndroidKeystoreSecureStorageHost(context, alias, root)
        val event = recreated.execute(
            androidHostEffect(CoreEffectKind.SecureStorageRead, CoreField.Text(29, "device-token")),
        ).toList().single()
        assertArrayEquals(secret, event.androidBytes(30))

        recreated.execute(
            androidHostEffect(CoreEffectKind.SecureStorageDelete, CoreField.Text(29, "device-token")),
        ).toList()
        recreated.deleteKey()
            root.deleteRecursively()
        }
    }
}

private fun ByteArray.containsSlice(value: ByteArray): Boolean =
    indices.any { start -> start + value.size <= size && copyOfRange(start, start + value.size).contentEquals(value) }
