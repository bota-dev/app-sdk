package dev.bota.sdk.speech

import android.content.Context
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject

public enum class SpeechCaptureError { INVALID_INPUT, UNAVAILABLE, UNAUTHORIZED, BUSY, CLOSED }
public class SpeechCaptureException(public val error: SpeechCaptureError) : Exception("speech_capture_${error.name.lowercase()}")
public data class SpeechCaptureClock(public val id: String, public val samples: Long, public val endKnown: Boolean)
public data class SpeechCaptureSnapshot(public val captureId: String, public val recordingId: String, public val archiveSamples: Long,
    public val nextSequence: Int, public val activeClock: Boolean, public val finished: Boolean, public val clocks: List<SpeechCaptureClock>)

/** Native host HTTP only. Scoped keys and ciphertext must not cross Dart/Pigeon/JS bridges. */
public interface SpeechCaptureHost {
    public suspend fun status(captureId: String): ByteArray
    public suspend fun upload(captureId: String, packet: ByteArray): ByteArray
    public suspend fun complete(captureId: String, manifest: ByteArray): ByteArray
}

/** Independent original archive. Rust owns clocks/chains/receipt policy; native
 * AES-GCM, Android Keystore and SQLite own bytes and atomic local durability. */
public class SpeechCaptureArchive private constructor(
    private val store: SpeechCaptureStorage,
    private val keys: SpeechCaptureKeys,
    private var key: SecretKey?,
    private var journal: JSONObject,
    private val captureId: String,
) {
    private val gate = Mutex()
    private val tasks = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var network: Deferred<ByteArray>? = null
    private var retirement: Deferred<Unit>? = null
    private var closed = false
    private var published = false

    public companion object {
        /** Scoped identity discovery only, including publication tombstones.
         * Query host status for completed identities; never infer completion from a file name. */
        public suspend fun list(context: Context, scope: String): List<String> = withContext(Dispatchers.IO) {
            safe { frozen(SpeechCaptureStorage.list(scope, context.applicationContext.noBackupFilesDir)) }
        }
        private fun invalid(): Nothing = throw SpeechCaptureException(SpeechCaptureError.INVALID_INPUT)
        private fun encode(value: JSONObject): ByteArray = value.toString().toByteArray(Charsets.UTF_8)
        private fun parse(bytes: ByteArray, maximum: Int = 65536): JSONObject {
            if (bytes.size > maximum) invalid()
            return JSONObject(bytes.toString(Charsets.UTF_8))
        }
        private fun command(op: String, vararg entries: Pair<String, Any>): JSONObject = JSONObject().put("op", op).apply {
            entries.forEach { (key, value) -> put(key, value) }
        }
        private fun policy(value: JSONObject): JSONObject = parse(SpeechCapturePolicy.evaluate(encode(value)))
        private fun decode(value: String): ByteArray = Base64.getDecoder().decode(value).also {
            if (Base64.getEncoder().encodeToString(it) != value) invalid()
        }
        private fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        private fun aad(captureId: String, kind: String): ByteArray = decode(policy(command("aad", "captureId" to captureId, "kind" to kind)).getString("aad"))
        private fun seal(bytes: ByteArray, key: SecretKey, aad: ByteArray): JSONObject {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key); cipher.updateAAD(aad)
            if (cipher.iv.size != 12) invalid()
            return JSONObject().put("nonce", Base64.getEncoder().encodeToString(cipher.iv))
                .put("ciphertext", Base64.getEncoder().encodeToString(cipher.doFinal(bytes)))
        }
        private fun open(packet: JSONObject, key: SecretKey, aad: ByteArray, maximum: Int): ByteArray {
            val nonce = decode(packet.getString("nonce")); val bytes = decode(packet.getString("ciphertext"))
            if (nonce.size != 12 || bytes.size < 16 || bytes.size > maximum + 16) invalid()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, nonce)); cipher.updateAAD(aad)
            return cipher.doFinal(bytes)
        }
        private fun encrypted(journal: JSONObject, key: SecretKey, captureId: String): ByteArray {
            val plain = encode(journal)
            try { if (plain.size > 65536) invalid(); return encode(seal(plain, key, aad(captureId, "journal"))) }
            finally { plain.fill(0) }
        }
        private fun finished(journal: JSONObject, key: SecretKey): JSONObject {
            if (journal.has("manifest")) return journal
            val result = policy(command("finish", "state" to journal.getJSONObject("state")))
            val manifest = seal(encode(result.getJSONObject("manifest")), key, decode(result.getString("aad")))
            return JSONObject(journal.toString()).put("state", result.getJSONObject("state")).put("manifest", manifest)
                .put("manifestSha256", digest((manifest.getString("nonce") + "\u0000" + manifest.getString("ciphertext")).toByteArray(Charsets.UTF_8)))
        }
        private inline fun <T> safe(work: () -> T): T = try { work() } catch (error: CancellationException) { throw error }
            catch (error: SpeechCaptureException) { throw error } catch (_: Exception) { throw SpeechCaptureException(SpeechCaptureError.UNAVAILABLE) }

        public suspend fun create(context: Context, scope: String, preparation: ByteArray): SpeechCaptureArchive =
            create(scope, preparation, context.applicationContext.noBackupFilesDir, SpeechCaptureKeyStore())
        internal suspend fun create(scope: String, preparation: ByteArray, directory: File, keys: SpeechCaptureKeys): SpeechCaptureArchive {
            val owned = preparation.copyOf()
            var acquired: SpeechCaptureArchive? = null
            try { return withContext(Dispatchers.IO) { safe {
                val p = parse(owned, 8192)
                if (p.get("protocol_version") != 1 || p.get("profile") != "speech_capture_pcm_v1" || p.get("sample_rate") != 48000 ||
                    p.get("channels") != 1 || p.get("format") != "pcm_s16le" || p.get("cipher") != "AES-256-GCM" ||
                    p.get("maximum_chunk_samples") != 48000 || !Instant.parse(p.getString("upload_until")).isAfter(Instant.now())) invalid()
                val captureId = p.getString("capture_id")
                val state = policy(command("create", "captureId" to captureId, "recordingId" to p.getString("recording_id"), "retention" to "original_audio_and_text"))
                val store = SpeechCaptureStorage(scope, captureId, directory)
                try {
                    if (store.journal() != null || store.receipt() != null) throw SpeechCaptureException(SpeechCaptureError.BUSY)
                    val raw = decode(p.getString("data_key"))
                    try { if (raw.size != 32) invalid(); keys.write(store.keyId, raw) } finally { raw.fill(0) }
                    val key = keys.read(store.keyId) ?: invalid()
                    val journal = JSONObject().put("scope", scope).put("state", state)
                    store.save(encrypted(journal, key, captureId))
                    SpeechCaptureArchive(store, keys, key, journal, captureId).also { acquired = it }
                } catch (error: Throwable) { store.close(); throw error }
            } } } catch (error: Throwable) { withContext(NonCancellable) { acquired?.close() }; throw error }
            finally { owned.fill(0) }
        }
        public suspend fun recover(context: Context, scope: String, captureId: String): SpeechCaptureArchive =
            recover(scope, captureId, context.applicationContext.noBackupFilesDir, SpeechCaptureKeyStore())
        internal suspend fun recover(scope: String, captureId: String, directory: File, keys: SpeechCaptureKeys): SpeechCaptureArchive {
            var acquired: SpeechCaptureArchive? = null
            try { return withContext(Dispatchers.IO) { safe {
                val aad = aad(captureId, "journal")
                val store = SpeechCaptureStorage(scope, captureId, directory)
                try {
                    if (store.receipt() != null) { keys.delete(store.keyId); throw SpeechCaptureException(SpeechCaptureError.CLOSED) }
                    val key = keys.read(store.keyId) ?: invalid()
                    val raw = open(parse(store.journal() ?: invalid(), 100000), key, aad, 65536)
                    var journal = try { parse(raw) } finally { raw.fill(0) }
                    val state = policy(command("restore", "state" to journal.getJSONObject("state")))
                    if (journal.getString("scope") != scope || state.getString("captureId") != captureId) invalid()
                    journal.put("state", state)
                    if (!state.getBoolean("finished")) {
                        journal.put("state", policy(command("recover", "state" to state)))
                        journal = finished(journal, key); store.save(encrypted(journal, key, captureId))
                    }
                    SpeechCaptureArchive(store, keys, key, journal, captureId).also { acquired = it }
                } catch (error: Throwable) { store.close(); throw error }
            } } } catch (error: Throwable) { withContext(NonCancellable) { acquired?.close() }; throw error }
        }
    }
    private fun active(): SecretKey {
        if (closed || published) throw SpeechCaptureException(SpeechCaptureError.CLOSED)
        return key ?: throw SpeechCaptureException(SpeechCaptureError.CLOSED)
    }
    private suspend fun <T> local(work: () -> T): T = withContext(Dispatchers.IO) {
        gate.withLock { currentCoroutineContext().ensureActive(); safe { work() } }
    }
    private fun save(next: JSONObject, chunk: SpeechCaptureStorage.Chunk? = null) {
        store.save(encrypted(next, active(), captureId), chunk); journal = next
    }
    public suspend fun snapshot(): SpeechCaptureSnapshot = local {
        val value = journal.getJSONObject("state")
        val clocks = value.getJSONArray("clocks")
        SpeechCaptureSnapshot(value.getString("captureId"), value.getString("recordingId"), value.getLong("archiveSamples"), value.getInt("nextSequence"),
            value.getBoolean("activeClock"), value.getBoolean("finished"), frozen((0 until clocks.length()).map { index ->
                val clock = clocks.getJSONObject(index); SpeechCaptureClock(clock.getString("id"), clock.getLong("samples"), clock.getBoolean("endKnown"))
            }))
    }
    public suspend fun beginClock(clockId: String): Unit = local {
        save(JSONObject(journal.toString()).put("state", policy(command("begin_clock", "state" to journal.getJSONObject("state"), "clockId" to clockId))))
    }
    /** Call from a bounded native queue; this copies at most one second. */
    public suspend fun append(firstSample: Long, pcm: ByteArray) {
        if (pcm.isEmpty() || pcm.size > 96000 || pcm.size % 2 != 0) invalid()
        val owned = pcm.copyOf()
        try { local {
            val plan = policy(command("plan", "state" to journal.getJSONObject("state"), "firstSample" to firstSample, "samples" to owned.size / 2))
            val header = plan.getJSONObject("header")
            val aad = decode(plan.getString("aad"))
            val packet = seal(owned, active(), aad)
            val sha256 = digest(aad + decode(packet.getString("nonce")) + decode(packet.getString("ciphertext")))
            val state = policy(command("commit", "state" to journal.getJSONObject("state"), "header" to header, "sha256" to sha256))
            packet.put("header", header)
            save(JSONObject(journal.toString()).put("state", state), SpeechCaptureStorage.Chunk(header.getInt("sequence"), encode(packet), sha256))
        } } finally { owned.fill(0) }
    }
    public suspend fun endClock(samples: Long): Unit = local {
        save(JSONObject(journal.toString()).put("state", policy(command("end_clock", "state" to journal.getJSONObject("state"), "samples" to samples))))
    }
    public suspend fun interruptClock(): Unit = local {
        save(JSONObject(journal.toString()).put("state", policy(command("recover", "state" to journal.getJSONObject("state")))))
    }
    public suspend fun finish(): Unit = local { if (!journal.has("manifest")) save(finished(journal, active())) }
    private suspend fun request(work: suspend () -> ByteArray): ByteArray {
        local { active() }
        val operation = tasks.async { work() }
        try {
            val bytes = withTimeout(15000) { operation.await() }
            local { active() }; if (bytes.size > 524288) invalid(); return bytes
        } finally { operation.cancel() }
    }
    public suspend fun flush(host: SpeechCaptureHost): ByteArray {
        val run = gate.withLock {
            active()
            network ?: tasks.async(start = CoroutineStart.LAZY) { upload(host) }.also { network = it }
        }
        run.start()
        try { return run.await() }
        finally {
            if (!currentCoroutineContext().isActive) run.cancel()
            withContext(NonCancellable) { gate.withLock { if (network === run && run.isCompleted) network = null } }
        }
    }
    private suspend fun upload(host: SpeechCaptureHost): ByteArray {
        var receipt = request { host.status(captureId) }
        if (parse(receipt, 524288).optString("state") != "published") {
            val count = snapshot().nextSequence
            for (sequence in 0 until count) {
                val packet = local { active(); if (store.uploaded(sequence)) null else store.packet(sequence) ?: invalid() } ?: continue
                val ack = parse(request { host.upload(captureId, packet) })
                local {
                    active(); if (ack.get("sequence") != sequence || ack.get("stored") != true) invalid()
                    store.acknowledge(sequence, ack.getString("sha256"))
                }
            }
            val manifest = local {
                active()
                if (journal.has("manifest") && journal.getJSONObject("state").getInt("nextSequence") == count) encode(journal.getJSONObject("manifest")) else null
            }
            if (manifest != null) receipt = request { host.complete(captureId, manifest) }
        }
        if (parse(receipt, 524288).optString("state") == "published") local {
            active()
            policy(command("receipt", "state" to journal.getJSONObject("state"), "manifestSha256" to journal.getString("manifestSha256"), "receipt" to parse(receipt, 524288)))
            store.publish(receipt); published = true; key = null; keys.delete(store.keyId)
        }
        return receipt
    }
    /** Cancels bounded host IO, joins local writes, and retains unpublished originals. */
    public suspend fun close(): Unit = withContext(NonCancellable) {
        val pending = gate.withLock {
            retirement ?: CoroutineScope(SupervisorJob() + Dispatchers.IO).async(start = CoroutineStart.LAZY) {
                val run = gate.withLock { closed = true; network?.also { it.cancel() } }
                tasks.cancel(); run?.join()
                gate.withLock { try { if (published) keys.delete(store.keyId) } finally { key = null; store.close() } }
            }.also { retirement = it }
        }
        pending.start(); pending.await()
    }
}
