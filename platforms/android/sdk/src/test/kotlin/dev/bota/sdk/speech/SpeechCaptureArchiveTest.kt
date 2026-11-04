package dev.bota.sdk.speech

import java.util.Base64
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicLong
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.async
import kotlinx.coroutines.withContext
import kotlinx.coroutines.NonCancellable
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [35])
class SpeechCaptureArchiveTest {
    private class Keys : SpeechCaptureKeys {
        private val keys = mutableMapOf<String, SecretKey>()
        val count get() = keys.size
        override fun read(id: String): SecretKey? = keys[id]
        override fun write(id: String, bytes: ByteArray) { keys[id] = SecretKeySpec(bytes.copyOf(), "AES") }
        override fun delete(id: String) { keys.remove(id) }
    }
    private fun preparation(capture: String) = JSONObject().put("protocol_version", 1).put("profile", "speech_capture_pcm_v1")
        .put("capture_id", capture).put("recording_id", "rec_fixture").put("sample_rate", 48000).put("channels", 1)
        .put("format", "pcm_s16le").put("cipher", "AES-256-GCM").put("maximum_chunk_samples", 48000)
        .put("upload_until", "2099-01-01T00:00:00Z").put("data_key", Base64.getEncoder().encodeToString(ByteArray(32) { 7 })).toString().toByteArray()

    @Test fun exactReceiptDeletesKeyAndCiphertextButWrongReceiptKeepsRecovery(): Unit = runBlocking {
        val capture = "10000000-0000-4000-8000-000000000005"; val clock = "20000000-0000-4000-8000-000000000005"
        val keys = Keys(); val root = RuntimeEnvironment.getApplication().noBackupFilesDir; val scope = "receipt-owner"
        var archive = SpeechCaptureArchive.create(scope, preparation(capture), root, keys)
        archive.beginClock(clock); archive.append(0, byteArrayOf(9, 0)); archive.endClock(1); archive.finish()
        var receipt: JSONObject? = null
        val host = object : SpeechCaptureHost {
            override suspend fun status(captureId: String) = (receipt?.toString() ?: "{\"state\":\"open\"}").toByteArray()
            override suspend fun upload(captureId: String, packet: ByteArray): ByteArray {
                fun run(value: JSONObject) = JSONObject(String(SpeechCapturePolicy.evaluate(value.toString().toByteArray())))
                val state = run(JSONObject().put("op", "create").put("captureId", capture).put("recordingId", "rec_fixture").put("retention", "original_audio_and_text"))
                val active = run(JSONObject().put("op", "begin_clock").put("state", state).put("clockId", clock))
                val plan = run(JSONObject().put("op", "plan").put("state", active).put("firstSample", 0).put("samples", 1))
                val value = JSONObject(String(packet)); val decoder = Base64.getDecoder()
                val sha = MessageDigest.getInstance("SHA-256").digest(decoder.decode(plan.getString("aad")) +
                    decoder.decode(value.getString("nonce")) + decoder.decode(value.getString("ciphertext"))).joinToString("") { "%02x".format(it) }
                return JSONObject().put("sequence", 0).put("sha256", sha).put("stored", true).toString().toByteArray()
            }
            override suspend fun complete(captureId: String, manifest: ByteArray): ByteArray {
                val packet = JSONObject(String(manifest))
                val sha = MessageDigest.getInstance("SHA-256").digest((packet.getString("nonce") + "\u0000" + packet.getString("ciphertext")).toByteArray()).joinToString("") { "%02x".format(it) }
                receipt = JSONObject().put("profile", "speech_capture_pcm_v1").put("capture_id", capture).put("recording_id", "wrong_recording")
                    .put("state", "published").put("audio_verification", "verified").put("archive_samples", 1).put("manifest_sha256", sha).put("content_sha256", "ab".repeat(32))
                return receipt.toString().toByteArray()
            }
        }
        assertTrue(runCatching { archive.flush(host) }.isFailure); assertEquals(1, keys.count)
        archive.close(); archive = SpeechCaptureArchive.recover(scope, capture, root, keys)
        assertEquals(1L, archive.snapshot().archiveSamples)
        receipt!!.put("recording_id", "rec_fixture")
        archive.flush(host); assertEquals(0, keys.count); archive.close()
        SpeechCaptureStorage(scope, capture, root).use { store ->
            assertNull(store.packet(0)); assertNull(store.journal()); assertNotNull(store.receipt())
        }
        assertTrue(runCatching { SpeechCaptureArchive.recover(scope, capture, root, keys) }.isFailure)
        assertTrue(runCatching { SpeechCaptureArchive.create(scope, preparation(capture), root, keys) }.isFailure)
        assertEquals(0, keys.count)
    }

    @Test fun closeFencesUncooperativeHttpWithoutDeletingTheOriginal(): Unit = runBlocking {
        val capture = "10000000-0000-4000-8000-000000000006"
        val keys = Keys(); val root = RuntimeEnvironment.getApplication().noBackupFilesDir
        val archive = SpeechCaptureArchive.create("late-http", preparation(capture), root, keys)
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val result = async { runCatching { archive.flush(object : SpeechCaptureHost {
            override suspend fun status(captureId: String): ByteArray {
                entered.complete(Unit); withContext(NonCancellable) { release.await() }; return "{\"state\":\"open\"}".toByteArray()
            }
            override suspend fun upload(captureId: String, packet: ByteArray): ByteArray = error("Unexpected upload")
            override suspend fun complete(captureId: String, manifest: ByteArray): ByteArray = error("Unexpected completion")
        }) } }
        withTimeout(5000) { entered.await(); archive.close() }
        release.complete(Unit); assertTrue(result.await().isFailure); assertEquals(1, keys.count)
        val recovered = SpeechCaptureArchive.recover("late-http", capture, root, keys)
        assertTrue(recovered.snapshot().finished); recovered.close()
    }

    @Test fun canonicalVectorUsesActualJavaAesAndRustJni() {
        val path = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .map { File(it, "protocol/speech-session/capture-v1.json") }.first { it.isFile }
        val bytes = path.readBytes()
        assertEquals("4554c3bcadcf7a54e01ad34edd07b3b97e1cc8276e0b1d0b4fbb795c37035009", MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
        val fixture = JSONObject(bytes.toString(Charsets.UTF_8)); val decoder = Base64.getDecoder()
        val key = SecretKeySpec(decoder.decode(fixture.getString("key")), "AES")
        fun open(packet: JSONObject, aad: String): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, decoder.decode(packet.getString("nonce"))))
            cipher.updateAAD(decoder.decode(aad)); return cipher.doFinal(decoder.decode(packet.getString("ciphertext")))
        }
        val chunks = fixture.getJSONArray("chunks")
        for (index in 0 until chunks.length()) {
            val value = chunks.getJSONObject(index)
            assertEquals(value.getString("pcmHex"), open(value.getJSONObject("packet"), value.getString("aad")).joinToString("") { "%02x".format(it) })
        }
        val manifest = fixture.getJSONObject("manifest")
        assertArrayEquals(decoder.decode(manifest.getString("plaintext")), open(manifest.getJSONObject("packet"), manifest.getString("aad")))
        val aad = JSONObject(String(SpeechCapturePolicy.evaluate(JSONObject().put("op", "aad").put("captureId", fixture.getString("captureId"))
            .put("kind", "manifest").toString().toByteArray())))
        assertEquals(manifest.getString("aad"), aad.getString("aad"))
    }

    @Test fun revokedMicrophonePermissionStopsThePumpAndPreservesRecovery(): Unit = runBlocking {
        val capture = "10000000-0000-4000-8000-000000000007"
        val keys = Keys(); val root = RuntimeEnvironment.getApplication().noBackupFilesDir
        val archive = SpeechCaptureArchive.create("revoked-microphone", preparation(capture), root, keys)
        val failure = runCatching {
            SpeechMicrophoneCapture.start(archive, 1500, { error("Unexpected RTC frame") },
                {}, { throw SecurityException("Permission revoked after admission") }, { 1000 }, { 0 })
        }.exceptionOrNull()
        assertTrue(failure is SpeechCaptureException)
        assertEquals(SpeechCaptureError.UNAUTHORIZED, (failure as SpeechCaptureException).error)
        assertEquals(0L, archive.snapshot().archiveSamples)
        archive.close()
        val recovered = SpeechCaptureArchive.recover("revoked-microphone", capture, root, keys)
        assertEquals(0L, recovered.snapshot().archiveSamples)
        assertEquals(1, keys.count); recovered.close()
    }

    @Test fun microphoneFeedsSameBytesToRtcAndDiskAndStopsAtAuthorizationExpiry(): Unit = runBlocking {
        val capture = "10000000-0000-4000-8000-000000000004"
        val keys = Keys(); val root = RuntimeEnvironment.getApplication().noBackupFilesDir
        val archive = SpeechCaptureArchive.create("microphone-owner", preparation(capture), root, keys)
        val now = AtomicLong(1000); val ended = CompletableDeferred<SpeechCaptureEnd>()
        val sourcePcm = ByteArray(960) { (it % 127).toByte() }
        var sourceClosed = false; var delivered: ByteArray? = null
        val source = object : SpeechMicrophoneSource {
            override val route = 1
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                sourcePcm.copyInto(buffer, offset); now.set(2000); return sourcePcm.size
            }
            override fun close() { sourceClosed = true }
        }
        val microphone = SpeechMicrophoneCapture.start(archive, 1500, { delivered = it.copyOf(); throw IllegalStateException("RTC retired") },
            { ended.complete(it) }, { source }, now::get, { 0 })
        assertEquals(SpeechCaptureEnd.AUTHORIZATION_EXPIRED, withTimeout(5000) { ended.await() })
        microphone.stop(); assertTrue(sourceClosed); assertArrayEquals(sourcePcm, delivered)
        val state = archive.snapshot(); assertEquals(480L, state.archiveSamples); assertTrue(state.clocks.single().endKnown)
        archive.finish()
        var storedPcm: ByteArray? = null
        val host = object : SpeechCaptureHost {
            override suspend fun status(captureId: String) = "{\"state\":\"open\"}".toByteArray()
            override suspend fun upload(captureId: String, packet: ByteArray): ByteArray {
                val chunk = JSONObject(String(packet)); val header = chunk.getJSONObject("header")
                val seed = JSONObject(String(SpeechCapturePolicy.evaluate(JSONObject().put("op", "create").put("captureId", captureId)
                    .put("recordingId", "rec_fixture").put("retention", "original_audio_and_text").toString().toByteArray())))
                val active = JSONObject(String(SpeechCapturePolicy.evaluate(JSONObject().put("op", "begin_clock").put("state", seed)
                    .put("clockId", header.getString("clockId")).toString().toByteArray())))
                val plan = JSONObject(String(SpeechCapturePolicy.evaluate(JSONObject().put("op", "plan").put("state", active)
                    .put("firstSample", 0).put("samples", 480).toString().toByteArray())))
                val decoder = Base64.getDecoder(); val aad = decoder.decode(plan.getString("aad"))
                val nonce = decoder.decode(chunk.getString("nonce")); val ciphertext = decoder.decode(chunk.getString("ciphertext"))
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(ByteArray(32) { 7 }, "AES"), GCMParameterSpec(128, nonce)); cipher.updateAAD(aad)
                storedPcm = cipher.doFinal(ciphertext)
                val sha = MessageDigest.getInstance("SHA-256").digest(aad + nonce + ciphertext).joinToString("") { "%02x".format(it) }
                return JSONObject().put("sequence", 0).put("sha256", sha).put("stored", true).toString().toByteArray()
            }
            override suspend fun complete(captureId: String, manifest: ByteArray) = "{\"state\":\"sealed\"}".toByteArray()
        }
        archive.flush(host); assertArrayEquals(delivered, storedPcm); archive.close()
        val recovered = SpeechCaptureArchive.recover("microphone-owner", capture, root, keys)
        assertEquals(480L, recovered.snapshot().archiveSamples); recovered.close()
    }
    @Test fun encryptedJournalRecoversUnknownTailAndRejectsConcurrentOwner(): Unit = runBlocking {
        val root = RuntimeEnvironment.getApplication().noBackupFilesDir
        val capture = "10000000-0000-4000-8000-000000000001"
        val preparation = JSONObject().put("protocol_version", 1).put("profile", "speech_capture_pcm_v1")
            .put("capture_id", capture).put("recording_id", "rec_fixture").put("sample_rate", 48000).put("channels", 1)
            .put("format", "pcm_s16le").put("cipher", "AES-256-GCM").put("maximum_chunk_samples", 48000)
            .put("upload_until", "2099-01-01T00:00:00Z").put("data_key", Base64.getEncoder().encodeToString(ByteArray(32) { 7 }))
        val keys = Keys()
        val archive = SpeechCaptureArchive.create("synthetic-owner", preparation.toString().toByteArray(), root, keys)
        archive.beginClock("20000000-0000-4000-8000-000000000001")
        archive.append(4, byteArrayOf(1, 0, 2, 0))
        var refused = false
        try { SpeechCaptureArchive.recover("synthetic-owner", capture, root, keys) } catch (_: Exception) { refused = true }
        assertTrue(refused)
        archive.close()
        val recovered = SpeechCaptureArchive.recover("synthetic-owner", capture, root, keys)
        val state = recovered.snapshot()
        assertTrue(state.finished); assertEquals(2, state.archiveSamples)
        assertFalse(state.clocks.first().endKnown)
        recovered.close()
    }
}
