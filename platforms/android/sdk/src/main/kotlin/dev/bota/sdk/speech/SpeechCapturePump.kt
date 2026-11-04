package dev.bota.sdk.speech

import java.util.ArrayDeque
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withContext

internal interface SpeechCaptureSink {
    suspend fun begin(id: String)
    suspend fun append(firstSample: Long, bytes: ByteArray)
    suspend fun end(samples: Long)
    suspend fun interrupt()
}

/** A bounded disk branch. offer never waits for encryption, disk or HTTP. Missing
 * chunks retain their capture sample positions; stopping joins every accepted write. */
public class SpeechCapturePump private constructor(private val sink: SpeechCaptureSink, private val failed: () -> Unit) {
    private data class Chunk(val first: Long, val bytes: ByteArray)
    private val lock = Any()
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private val lifetime = SupervisorJob()
    private val tasks = CoroutineScope(lifetime + Dispatchers.IO)
    private val queue = ArrayDeque<Chunk>()
    private val partial = ByteArray(96000)
    private var partialBytes = 0
    private var outstanding = 0
    private var samples = 0L
    private var stopping = false
    private var known = false
    private lateinit var writer: Deferred<Unit>

    public companion object {
        public suspend fun start(archive: SpeechCaptureArchive, failed: () -> Unit = {}): SpeechCapturePump =
            start(object : SpeechCaptureSink {
                override suspend fun begin(id: String) { archive.beginClock(id) }
                override suspend fun append(firstSample: Long, bytes: ByteArray) { archive.append(firstSample, bytes) }
                override suspend fun end(samples: Long) { archive.endClock(samples) }
                override suspend fun interrupt() { archive.interruptClock() }
            }, UUID.randomUUID().toString(), failed)

        internal suspend fun start(sink: SpeechCaptureSink, clock: String, failed: () -> Unit): SpeechCapturePump {
            sink.begin(clock)
            return SpeechCapturePump(sink, failed).also { pump -> pump.writer = pump.tasks.async { pump.write() } }
        }
    }

    /** Copies mono 48 kHz PCM16LE. True includes archive drops under disk pressure;
     * the caller must still feed the same source bytes to its independent RTC branch. */
    public fun offer(pcm: ByteArray): Boolean = synchronized(lock) {
        if (stopping) return@synchronized false
        if (pcm.isEmpty() || pcm.size > 96000 || pcm.size % 2 != 0 || samples + pcm.size / 2 > 345600000L) {
            return@synchronized false
        }
        var offset = 0
        while (offset < pcm.size) {
            val count = minOf(partial.size - partialBytes, pcm.size - offset)
            pcm.copyInto(partial, partialBytes, offset, offset + count)
            partialBytes += count; offset += count; samples += count / 2
            if (partialBytes == partial.size) enqueue()
        }
        true
    }

    private fun enqueue() {
        if (partialBytes == 0) return
        if (outstanding < 4) {
            queue.addLast(Chunk(samples - partialBytes / 2, partial.copyOf(partialBytes)))
            outstanding++; wake.trySend(Unit)
        }
        partial.fill(0, 0, partialBytes); partialBytes = 0
    }

    private suspend fun write() {
        try {
            while (true) {
                val chunk = synchronized(lock) { queue.pollFirst() }
                if (chunk != null) {
                    try { sink.append(chunk.first, chunk.bytes) }
                    finally { chunk.bytes.fill(0); synchronized(lock) { outstanding-- } }
                    continue
                }
                val end = synchronized(lock) { if (stopping) samples to known else null }
                if (end != null) {
                    if (end.second) sink.end(end.first) else sink.interrupt()
                    return
                }
                wake.receive()
            }
        } catch (error: Throwable) {
            synchronized(lock) { stopping = true; known = false }
            runCatching { sink.interrupt() }
            runCatching { failed() }
            throw error
        } finally {
            synchronized(lock) {
                partial.fill(0); partialBytes = 0
                queue.forEach { it.bytes.fill(0) }; queue.clear(); outstanding = 0
            }
            wake.close(); lifetime.complete()
        }
    }

    /** Call only after the physical source has stopped and joined its callbacks.
     * An interrupted source has an unknown end, even if the last stored chunk is valid. */
    public suspend fun stop(endKnown: Boolean): Unit = withContext(NonCancellable) {
        synchronized(lock) {
            if (!stopping) { stopping = true; known = endKnown; enqueue(); wake.trySend(Unit) }
        }
        writer.await()
    }
}
