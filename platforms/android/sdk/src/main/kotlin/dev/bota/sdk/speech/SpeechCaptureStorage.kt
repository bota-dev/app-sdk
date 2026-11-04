package dev.bota.sdk.speech

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import android.security.keystore.KeyProperties
import android.security.keystore.KeyProtection
import java.io.File
import java.io.RandomAccessFile
import java.nio.channels.FileLock
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.SecretKey
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

internal interface SpeechCaptureKeys {
    fun read(id: String): SecretKey?
    fun write(id: String, bytes: ByteArray)
    fun delete(id: String)
}
internal class SpeechCaptureKeyStore : SpeechCaptureKeys {
    private val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun alias(id: String) = "dev.bota.speech.capture.v1:$id"
    override fun read(id: String): SecretKey? = store.getKey(alias(id), null) as? SecretKey
    override fun write(id: String, bytes: ByteArray) {
        // Prove a surviving non-exportable key matches a replayed preparation;
        // never replace it after an uncertain create.
        read(id)?.let { existing ->
            val challenge = Cipher.getInstance("AES/GCM/NoPadding")
            challenge.init(Cipher.ENCRYPT_MODE, existing)
            val response = challenge.doFinal(byteArrayOf())
            val check = Cipher.getInstance("AES/GCM/NoPadding")
            check.init(Cipher.DECRYPT_MODE, SecretKeySpec(bytes, "AES"), GCMParameterSpec(128, challenge.iv))
            if (check.doFinal(response).isNotEmpty()) throw SpeechCaptureException(SpeechCaptureError.INVALID_INPUT)
            return
        }
        store.setEntry(alias(id), KeyStore.SecretKeyEntry(SecretKeySpec(bytes, "AES")),
            KeyProtection.Builder(KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
    }
    override fun delete(id: String) { store.deleteEntry(alias(id)) }
}

/** One owner holds the file lock until joined teardown. SQLite stores ciphertext
 * and metadata only; its FULL transaction commits journal and chunk together. */
internal class SpeechCaptureStorage(scope: String, captureId: String, directory: File) : AutoCloseable {
    companion object {
        private fun scopeHash(scope: String): String {
            if (scope.isEmpty() || scope.toByteArray().size > 512) throw SpeechCaptureException(SpeechCaptureError.INVALID_INPUT)
            return MessageDigest.getInstance("SHA-256").digest(scope.toByteArray()).joinToString("") { "%02x".format(it) }
        }
        fun list(scope: String, directory: File): List<String> {
            val parent = File(File(directory.canonicalFile, "speech-capture-v1"), scopeHash(scope))
            if (!parent.exists()) return emptyList()
            if (parent.canonicalFile != parent.absoluteFile) throw SpeechCaptureException(SpeechCaptureError.INVALID_INPUT)
            val names = parent.listFiles()?.filter { it.extension == "sqlite" && it.isFile && it.canonicalFile == it.absoluteFile }
                ?.map { it.nameWithoutExtension }?.sorted() ?: throw SpeechCaptureException(SpeechCaptureError.UNAVAILABLE)
            if (names.size > 256 || names.any { !Regex("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}").matches(it) }) {
                throw SpeechCaptureException(SpeechCaptureError.INVALID_INPUT)
            }
            return names
        }
    }
    val keyId: String
    private val file: RandomAccessFile
    private val lock: FileLock
    private val database: SQLiteDatabase
    private var revision = 0L
    init {
        val digest = scopeHash(scope)
        keyId = "$digest:$captureId"
        val parent = File(File(directory.canonicalFile, "speech-capture-v1"), digest)
        if (!parent.mkdirs() && !parent.isDirectory) throw SpeechCaptureException(SpeechCaptureError.UNAVAILABLE)
        val path = File(parent, "$captureId.sqlite")
        if (path.canonicalFile != path.absoluteFile) throw SpeechCaptureException(SpeechCaptureError.INVALID_INPUT)
        val lockPath = File(parent, "$captureId.lock")
        if (lockPath.canonicalFile != lockPath.absoluteFile) throw SpeechCaptureException(SpeechCaptureError.INVALID_INPUT)
        file = RandomAccessFile(lockPath, "rw")
        try { lock = file.channel.tryLock() ?: throw SpeechCaptureException(SpeechCaptureError.BUSY) }
        catch (error: Throwable) { file.close(); throw error }
        try {
            database = SQLiteDatabase.openDatabase(path.path, null, SQLiteDatabase.CREATE_IF_NECESSARY or SQLiteDatabase.OPEN_READWRITE)
            try {
                database.enableWriteAheadLogging()
                database.execSQL("PRAGMA synchronous=FULL")
                database.execSQL("CREATE TABLE IF NOT EXISTS capture(id INTEGER PRIMARY KEY CHECK(id=1),journal BLOB,receipt BLOB,revision INTEGER NOT NULL)")
                database.execSQL("CREATE TABLE IF NOT EXISTS chunks(sequence INTEGER PRIMARY KEY,packet BLOB NOT NULL,sha256 TEXT NOT NULL,uploaded INTEGER NOT NULL DEFAULT 0)")
                database.rawQuery("SELECT revision FROM capture WHERE id=1", null).use { if (it.moveToFirst()) revision = it.getLong(0) }
            } catch (error: Throwable) { database.close(); throw error }
        } catch (error: Throwable) { lock.release(); file.close(); throw error }
    }
    private fun bytes(sql: String, values: Array<String>? = null, maximum: Int = 140000): ByteArray? =
        database.rawQuery(sql, values).use { cursor ->
            if (!cursor.moveToFirst() || cursor.isNull(0)) null else cursor.getBlob(0).also {
                if (it.isEmpty() || it.size > maximum) throw SpeechCaptureException(SpeechCaptureError.INVALID_INPUT)
            }
        }
    fun journal(): ByteArray? = bytes("SELECT journal FROM capture WHERE id=1", maximum = 100000)
    fun receipt(): ByteArray? = bytes("SELECT receipt FROM capture WHERE id=1", maximum = 524288)
    fun packet(sequence: Int): ByteArray? = bytes("SELECT packet FROM chunks WHERE sequence=?", arrayOf(sequence.toString()))
    fun uploaded(sequence: Int): Boolean = database.rawQuery("SELECT uploaded FROM chunks WHERE sequence=?", arrayOf(sequence.toString())).use {
        it.moveToFirst() && it.getInt(0) == 1
    }
    fun acknowledge(sequence: Int, sha256: String) {
        val count = database.update("chunks", ContentValues().apply { put("uploaded", 1) }, "sequence=? AND sha256=?", arrayOf(sequence.toString(), sha256))
        if (count != 1) throw SpeechCaptureException(SpeechCaptureError.INVALID_INPUT)
    }
    data class Chunk(val sequence: Int, val packet: ByteArray, val sha256: String)
    fun save(journal: ByteArray, chunk: Chunk? = null) {
        database.beginTransaction()
        try {
            val old = database.rawQuery("SELECT revision FROM capture WHERE id=1", null).use { if (it.moveToFirst()) it.getLong(0) else null }
            if (!(old == null && revision == 0L || old == revision)) throw SpeechCaptureException(SpeechCaptureError.BUSY)
            if (chunk != null) database.insertOrThrow("chunks", null, ContentValues().apply {
                put("sequence", chunk.sequence); put("packet", chunk.packet); put("sha256", chunk.sha256)
            })
            val value = ContentValues().apply { put("id", 1); put("journal", journal); put("revision", revision + 1) }
            if (old == null) database.insertOrThrow("capture", null, value)
            else if (database.update("capture", value, "id=1 AND revision=?", arrayOf(revision.toString())) != 1)
                throw SpeechCaptureException(SpeechCaptureError.BUSY)
            database.setTransactionSuccessful()
        } finally { database.endTransaction() }
        revision++
    }
    fun publish(receipt: ByteArray) {
        database.beginTransaction()
        try {
            if (database.update("capture", ContentValues().apply { putNull("journal"); put("receipt", receipt); put("revision", revision + 1) }, "id=1", null) != 1)
                throw SpeechCaptureException(SpeechCaptureError.INVALID_INPUT)
            database.delete("chunks", null, null)
            database.setTransactionSuccessful()
        } finally { database.endTransaction() }
        revision++
    }
    override fun close() {
        try { database.close() } finally { try { if (lock.isValid) lock.release() } finally { file.close() } }
    }
}
