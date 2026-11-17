package dev.bota.sdk.speech

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import okhttp3.*
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject

public sealed interface RecordingSpeechMessage {
    public class Control(public val bytes: ByteArray) : RecordingSpeechMessage
    public class Audio(public val bytes: ByteArray) : RecordingSpeechMessage
}
public interface RecordingSpeechTransport {
    /** Enqueue synchronously with a bounded socket queue. */
    public fun send(message: RecordingSpeechMessage)
    public suspend fun receive(): RecordingSpeechMessage
    public suspend fun close()
}
public interface RecordingSpeechPlayback {
    public suspend fun clear()
    /** Copy synchronously; false reports bounded output pressure. */
    public fun play(pcm: ByteArray, outputId: String, offsetSamples: Long): Boolean
    public suspend fun drain()
}

/** Owned direct socket. No project key, token in URL, cookie, cache or redirect. */
public class RecordingSpeechWebSocket(url: String, protocolName: String) : RecordingSpeechTransport {
    private val incomingBytes = AtomicInteger()
    private fun bytes(message: RecordingSpeechMessage): ByteArray = when (message) {
        is RecordingSpeechMessage.Audio -> message.bytes
        is RecordingSpeechMessage.Control -> message.bytes
    }
    private val incoming = Channel<RecordingSpeechMessage>(32, onUndeliveredElement = {
        incomingBytes.addAndGet(-bytes(it).size); bytes(it).fill(0)
    })
    private val ended = CompletableDeferred<Unit>()
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .cookieJar(CookieJar.NO_COOKIES).cache(null).connectTimeout(10, TimeUnit.SECONDS).pingInterval(5, TimeUnit.SECONDS).build()
    private val socket = client.newWebSocket(Request.Builder().url(url).header("Sec-WebSocket-Protocol", protocolName).build(), object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (response.header("Sec-WebSocket-Protocol") != protocolName) webSocket.cancel()
        }
        private fun offer(webSocket: WebSocket, message: RecordingSpeechMessage, size: Int) {
            val total = incomingBytes.addAndGet(size)
            if (size > 32768 || total > 192000 || !incoming.trySend(message).isSuccess) {
                incomingBytes.addAndGet(-size); bytes(message).fill(0); webSocket.cancel()
            }
        }
        override fun onMessage(webSocket: WebSocket, text: String) { val bytes = text.toByteArray(Charsets.UTF_8); offer(webSocket, RecordingSpeechMessage.Control(bytes), bytes.size) }
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) { offer(webSocket, RecordingSpeechMessage.Audio(bytes.toByteArray()), bytes.size) }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { incoming.close(); ended.complete(Unit) }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { response?.close(); incoming.close(); ended.complete(Unit) }
    })
    override fun send(message: RecordingSpeechMessage) {
        check(socket.queueSize() + bytes(message).size <= 38400) { "recording speech queue full" }
        val accepted = when (message) {
            is RecordingSpeechMessage.Control -> socket.send(message.bytes.toString(Charsets.UTF_8))
            is RecordingSpeechMessage.Audio -> socket.send(message.bytes.toByteString())
        }
        check(accepted) { "recording speech socket closed" }
    }
    override suspend fun receive(): RecordingSpeechMessage = incoming.receive().also { incomingBytes.addAndGet(-bytes(it).size) }
    override suspend fun close() {
        socket.cancel()
        try { withTimeout(5000) { ended.await() } }
        finally { incoming.cancel(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
}

/** Rust owns protocol decisions. This owner handles native transport/playout;
 * original capture and encrypted archival retain their independent lifetime. */
public class RecordingSpeechSession(
    configurationJson: ByteArray,
    grantJson: ByteArray,
    private val playback: RecordingSpeechPlayback,
    transportFactory: (String, String) -> RecordingSpeechTransport = { url, protocol -> RecordingSpeechWebSocket(url, protocol) },
    private val onCaption: (ByteArray) -> Unit = {},
    private val onStatus: (String) -> Unit = {},
) {
    private data class Frame(val index: Int, val first: Long, val bytes: ByteArray)
    private val lock = Any()
    private val lifetime = SupervisorJob()
    private val tasks = CoroutineScope(lifetime + Dispatchers.IO)
    private val ready = CompletableDeferred<Unit>()
    private val finished = CompletableDeferred<Unit>()
    private var change: CompletableDeferred<Unit>? = null
    private var stopped = false
    private var completed = false
    private var closing: Deferred<Unit>? = null
    private val pending = ArrayList<Frame>()
    private var pendingBytes = 0
    private var state: JSONObject
    private val transport: RecordingSpeechTransport
    private val receiver: Job
    private val deadline: Job
    init {
        require(configurationJson.size <= 32768 && grantJson.size <= 32768)
        val created = policy(json("op" to "create", "configuration" to JSONObject(configurationJson.toString(Charsets.UTF_8)),
            "grant" to JSONObject(grantJson.toString(Charsets.UTF_8)), "nowMs" to System.currentTimeMillis()))
        state = created.getJSONObject("state")
        transport = transportFactory(created.getString("url"), created.getString("protocol"))
        try { transport.send(RecordingSpeechMessage.Control(created.getJSONObject("control").toString().toByteArray(Charsets.UTF_8))) }
        catch (error: Exception) {
            tasks.launch { try { transport.close() } finally { lifetime.cancel() } }
            throw error
        }
        receiver = tasks.launch(start = CoroutineStart.LAZY) { try { while (isActive) receive(transport.receive()) } catch (_: Exception) { interrupt() } }
        deadline = tasks.launch(start = CoroutineStart.LAZY) { delay(10000); if (!ready.isCompleted) interrupt() }
        receiver.start(); deadline.start()
    }
    private fun json(vararg entries: Pair<String, Any?>): JSONObject = JSONObject().apply { entries.forEach { (key, value) -> put(key, value ?: JSONObject.NULL) } }
    private fun policy(command: JSONObject): JSONObject = JSONObject(RecordingSpeechPolicy.evaluate(command.toString().toByteArray(Charsets.UTF_8)).toString(Charsets.UTF_8))
    private fun step(op: String, vararg entries: Pair<String, Any?>): JSONObject {
        check(!stopped) { "recording speech closed" }
        return policy(json("op" to op, "state" to state, *entries)).also { state = it.getJSONObject("state") }
    }
    private fun sendControl(value: JSONObject) { transport.send(RecordingSpeechMessage.Control(value.toString().toByteArray(Charsets.UTF_8))) }
    /** Validate the physical microphone against the server-admitted capture clock. */
    public fun bindMicrophone(clockId: String) { synchronized(lock) { step("bind_microphone", "clockId" to clockId) } }
    public suspend fun ready() { try { ready.await() } catch (error: Exception) { interrupt(); throw error } }
    /** Borrowed mono 48 kHz original frames, from the same native capture callback
     * as SpeechCapturePump. Advance the capture clock even if live IO refuses. */
    public fun offer(sourceIndex: Int, firstSample: Long, pcm: ByteArray): Boolean {
        try {
            return synchronized(lock) {
                if (stopped || !state.getBoolean("ready") || state.getBoolean("finishing") || pcm.isEmpty() || pcm.size > 9600 || pcm.size % 2 != 0) return@synchronized false
                if (!state.isNull("pending")) {
                    check(pendingBytes + pcm.size <= 38400) { "recording speech queue full" }
                    pending.add(Frame(sourceIndex, firstSample, pcm.copyOf())); pendingBytes += pcm.size; return@synchronized true
                }
                val header = step("frame", "sourceIndex" to sourceIndex, "firstSample" to firstSample, "samples" to pcm.size / 2).getJSONArray("header")
                val bytes = ByteArray(header.length() + pcm.size)
                for (index in 0 until header.length()) bytes[index] = header.getInt(index).toByte()
                pcm.copyInto(bytes, header.length())
                try { transport.send(RecordingSpeechMessage.Audio(bytes)) } finally { bytes.fill(0) }
                true
            }
        } catch (_: Exception) { interrupt(); return false }
    }
    private suspend fun clearAndAcknowledge() {
        playback.clear()
        synchronized(lock) { sendControl(step("playback_cleared", "revision" to state.getJSONObject("target").getInt("revision")).getJSONObject("control")) }
    }
    public suspend fun setRoute(headphones: Boolean) {
        val control = synchronized(lock) { step("route", "route" to if (headphones) "headphones" else "unqualified").getJSONObject("control") }
        if (!headphones) playback.clear()
        synchronized(lock) { check(!stopped); sendControl(control) }
    }
    public suspend fun changeTarget(language: String, requestId: String) {
        val (control, pendingChange) = synchronized(lock) {
            check(change == null)
            val control = step("target", "language" to language, "requestId" to requestId).getJSONObject("control")
            val pendingChange = CompletableDeferred<Unit>(); change = pendingChange; control to pendingChange
        }
        try { playback.clear(); synchronized(lock) { check(!stopped); sendControl(control) }; withTimeout(15000) { pendingChange.await() } }
        catch (error: Exception) { interrupt(); throw error }
    }
    public suspend fun finish() {
        try {
            synchronized(lock) { sendControl(step("finish").getJSONObject("control")) }
            withTimeout(60000) { finished.await() }
        } catch (error: Exception) { interrupt(); throw error }
    }
    private suspend fun receive(message: RecordingSpeechMessage) {
        when (message) {
            is RecordingSpeechMessage.Audio -> {
                val bytes = message.bytes
                try {
                    require(bytes.size in 18..32768 && bytes.copyOfRange(0, 4).toString(Charsets.US_ASCII) == "BRT1")
                    val view = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
                    val idSize = view.getShort(4).toInt() and 0xffff; val header = view.getShort(6).toInt() and 0xffff; val offset = view.getLong(8)
                    require(idSize <= 256 && header == 16 + idSize && bytes.size > header && (bytes.size - header) % 2 == 0 && offset >= 0)
                    val outputId = bytes.copyOfRange(16, header).toString(Charsets.UTF_8)
                    val blocked = synchronized(lock) {
                        val accepted = step("audio_chunk", "outputId" to outputId, "offsetSamples" to offset, "samples" to (bytes.size - header) / 2).getBoolean("accepted")
                        if (accepted) {
                            val pcm = bytes.copyOfRange(header, bytes.size)
                            try { !playback.play(pcm, outputId, offset) } finally { pcm.fill(0) }
                        } else false
                    }
                    if (blocked) { synchronized(lock) { step("clear") }; playback.clear(); report("output_skipped") }
                } finally { bytes.fill(0) }
            }
            is RecordingSpeechMessage.Control -> {
                require(message.bytes.size <= 32768)
                val event = JSONObject(message.bytes.toString(Charsets.UTF_8)); val type = event.getString("type")
                if (type == "ready") {
                    synchronized(lock) { step("ready", "event" to event, "nowMs" to System.currentTimeMillis()) }
                    clearAndAcknowledge(); ready.complete(Unit); deadline.cancel(); return
                }
                synchronized(lock) {
                    require(event.getString("activityId") == state.getJSONObject("configuration").getString("activityId") && event.getInt("generation") == state.getInt("generation"))
                }
                when (type) {
                    "target_committed" -> {
                        val target = event.getJSONObject("target")
                        synchronized(lock) { step("target_committed", "requestId" to event.getString("requestId"), "revision" to target.getInt("revision"), "language" to target.getString("language")) }
                        clearAndAcknowledge()
                        synchronized(lock) {
                            val frames = pending.toList(); pending.clear(); pendingBytes = 0
                            for (frame in frames) { try { check(offer(frame.index, frame.first, frame.bytes)) } finally { frame.bytes.fill(0) } }
                            change?.complete(Unit); change = null
                        }
                    }
                    "audio_clear" -> { synchronized(lock) { step("clear") }; playback.clear() }
                    "audio_start" -> synchronized(lock) {
                        require(event.getInt("sampleRate") == 24000)
                        step("audio_start", "activityId" to event.getString("activityId"), "generation" to event.getInt("generation"), "revision" to event.getInt("revision"), "outputId" to event.getString("outputId"))
                    }
                    "audio_end" -> synchronized(lock) { step("audio_end", "outputId" to event.getString("outputId"), "samples" to event.getLong("samples")) }
                    "caption" -> {
                        val value = event.getJSONObject("caption"); val text = value.getString("text"); event.getBoolean("final")
                        require(event.getInt("revision") == value.getInt("revision"))
                        val accepted = synchronized(lock) { step("caption", "activityId" to event.getString("activityId"), "generation" to event.getInt("generation"),
                            "revision" to value.getInt("revision"), "sourceId" to value.getString("sourceId"), "sourceEpoch" to value.getInt("sourceEpoch"),
                            "unitId" to value.getString("unitId"), "startSample" to value.getLong("startSample"), "endSample" to value.getLong("endSample"),
                            "sourceLanguage" to value.getString("sourceLanguage"), "targetLanguage" to if (value.has("targetLanguage")) value.getString("targetLanguage") else null,
                            "textBytes" to text.toByteArray(Charsets.UTF_8).size).getBoolean("accepted") }
                        if (accepted) runCatching { onCaption(message.bytes.copyOf()) }
                    }
                    "finished" -> { synchronized(lock) { completed = true }; playback.drain(); finished.complete(Unit) }
                    "status" -> report("interrupted")
                    else -> error("invalid recording speech event")
                }
            }
        }
    }
    private fun report(code: String) { runCatching { onStatus(code) } }
    private fun interrupt() {
        if (synchronized(lock) { !stopped && !completed }) report("interrupted")
        tasks.launch { runCatching { close() } }
    }
    public suspend fun close() {
        val cleanup = synchronized(lock) {
            closing ?: run {
                stopped = true; for (frame in pending) frame.bytes.fill(0); pending.clear(); pendingBytes = 0
                deadline.cancel(); ready.completeExceptionally(IllegalStateException("recording speech closed")); change?.cancel(); finished.completeExceptionally(IllegalStateException("recording speech closed"))
                tasks.async(NonCancellable) {
                    try {
                        try { playback.clear() } finally {
                            try { transport.close() } finally { receiver.cancelAndJoin() }
                        }
                    } finally { lifetime.cancel() }
                }.also { closing = it }
            }
        }
        withContext(NonCancellable) { cleanup.await() }
    }
}
