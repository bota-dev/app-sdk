package dev.bota.sdk.internal.host

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.HostEventKind
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal class AndroidKeystoreSecureStorageHost(
    context: Context,
    private val keyAlias: String = "dev.bota.app-sdk.secure-storage.v1",
    rootDirectory: File = File(context.applicationContext.noBackupFilesDir, "bota-app-sdk/secrets"),
) : SecureStorageHost {
    private val root = rootDirectory.apply { mkdirs() }
    private val keyStore = KeyStore.getInstance(AndroidKeyStore).apply { load(null) }
    private val mutex = Mutex()

    override fun execute(effect: CoreEffect): Flow<CoreHostEventPayload> = flow {
        mutex.withLock {
            val key = validOpaqueId(requiredText(effect, HostFieldId.Key))
            when (effect.kind) {
                CoreEffectKind.SecureStorageRead -> {
                    val value = read(key)
                    emit(
                        CoreHostEventPayload(
                            HostEventKind.SecretLoaded,
                            buildList {
                                add(CoreField.Text(HostFieldId.Key, key))
                                value?.let { add(CoreField.Bytes(HostFieldId.Value, it)) }
                            },
                        ),
                    )
                }
                CoreEffectKind.SecureStorageWrite -> {
                    write(key, requiredBytes(effect, HostFieldId.Value))
                    emit(stored(key))
                }
                CoreEffectKind.SecureStorageDelete -> {
                    AtomicFile(file(key)).delete()
                    emit(stored(key))
                }
                else -> throw NativeHostException(422, "non-secure-storage effect reached Keystore host")
            }
        }
    }.flowOn(Dispatchers.IO)

    internal fun ciphertextFile(key: String): File = file(validOpaqueId(key))

    internal fun deleteKey() {
        keyStore.deleteEntry(keyAlias)
    }

    private fun read(key: String): ByteArray? {
        val file = AtomicFile(file(key))
        if (!file.baseFile.exists()) return null
        val secretKey = keyStore.getKey(keyAlias, null) as? SecretKey
            ?: throw NativeHostException(409, "secure-storage key is unavailable")
        val encoded = file.openRead().use { it.readBytes() }
        val input = DataInputStream(ByteArrayInputStream(encoded))
        if (input.readUnsignedByte() != FormatVersion) throw NativeHostException(422, "unknown secret format")
        val iv = ByteArray(input.readUnsignedByte()).also(input::readFully)
        val ciphertext = input.readBytes()
        return Cipher.getInstance(CipherTransformation).run {
            init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(GcmTagBits, iv))
            updateAAD(key.encodeToByteArray())
            doFinal(ciphertext)
        }
    }

    private fun write(key: String, value: ByteArray) {
        val cipher = Cipher.getInstance(CipherTransformation).apply {
            init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            updateAAD(key.encodeToByteArray())
        }
        val ciphertext = cipher.doFinal(value)
        val encoded = ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.writeByte(FormatVersion)
                output.writeByte(cipher.iv.size)
                output.write(cipher.iv)
                output.write(ciphertext)
            }
            bytes.toByteArray()
        }
        val file = AtomicFile(file(key))
        val output = file.startWrite()
        try {
            output.write(encoded)
            output.fd.sync()
            file.finishWrite(output)
        } catch (error: Throwable) {
            file.failWrite(output)
            throw error
        }
    }

    private fun getOrCreateKey(): SecretKey {
        (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, AndroidKeyStore).run {
            init(
                KeyGenParameterSpec.Builder(
                    keyAlias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            generateKey()
        }
    }

    private fun file(key: String): File {
        val digest = MessageDigest.getInstance("SHA-256").digest(key.encodeToByteArray())
        val name = digest.joinToString("") { "%02x".format(it) }
        return File(root, "$name.secret")
    }

    private fun stored(key: String) =
        CoreHostEventPayload(HostEventKind.SecretStored, listOf(CoreField.Text(HostFieldId.Key, key)))

    private companion object {
        const val AndroidKeyStore = "AndroidKeyStore"
        const val CipherTransformation = "AES/GCM/NoPadding"
        const val FormatVersion = 1
        const val GcmTagBits = 128
    }
}
