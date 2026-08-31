package dev.bota.sdk.internal.host

import android.os.ParcelFileDescriptor
import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.HostEventKind
import java.nio.ByteBuffer
import java.nio.file.Path
import java.util.zip.CRC32
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal class FileRecordingSinkHost(
    private val registry: FileResourceRegistry = FileResourceRegistry(),
) : RecordingSinkHost, AutoCloseable {
    private val mutex = Mutex()
    private val prepared = mutableSetOf<String>()

    fun registerPath(sinkId: String, path: Path) = registry.registerPath(sinkId, path)

    fun registerDescriptor(sinkId: String, descriptor: ParcelFileDescriptor) =
        registry.registerDescriptor(sinkId, descriptor)

    fun unregister(sinkId: String) {
        prepared.remove(sinkId)
        registry.remove(sinkId)
    }

    override fun execute(effect: CoreEffect): Flow<CoreHostEventPayload> = flow {
        mutex.withLock {
            val sinkId = validOpaqueId(requiredText(effect, HostFieldId.SinkId))
            val resource = registry.resource(sinkId)
            when (effect.kind) {
                CoreEffectKind.RecordingSinkTruncate -> {
                    val completed = requiredUnsigned(effect, HostFieldId.CompletedUnits).toLongChecked()
                    resource.openWrite().use { channel ->
                        channel.truncate(completed)
                        channel.force(true)
                    }
                    prepared += sinkId
                    emit(CoreHostEventPayload(HostEventKind.RecordingSinkTruncated))
                }
                CoreEffectKind.RecordingSinkAppend -> {
                    requirePrepared(sinkId)
                    val payload = requiredBytes(effect, HostFieldId.Payload)
                    val durable = resource.openWrite().use { channel ->
                        channel.position(channel.size())
                        val buffer = ByteBuffer.wrap(payload)
                        while (buffer.hasRemaining()) channel.write(buffer)
                        channel.force(true)
                        channel.position().toULong()
                    }
                    emit(
                        CoreHostEventPayload(
                            HostEventKind.RecordingSinkAppendCompleted,
                            listOf(CoreField.Unsigned(HostFieldId.DurableUnits, durable)),
                        ),
                    )
                }
                CoreEffectKind.RecordingSinkFinalize -> {
                    requirePrepared(sinkId)
                    val size = resource.openRead().use(FileChannelSize)
                    val expected = effect.packet.unsigneds(HostFieldId.ExpectedCrc32).firstOrNull()
                    val kind = if (expected != null && crc32(resource).toULong() != expected) {
                        HostEventKind.RecordingSinkIntegrityFailed
                    } else {
                        HostEventKind.RecordingSinkFinalized
                    }
                    val fields = if (kind == HostEventKind.RecordingSinkFinalized) {
                        listOf(CoreField.Unsigned(HostFieldId.DurableUnits, size))
                    } else {
                        emptyList()
                    }
                    emit(CoreHostEventPayload(kind, fields))
                }
                CoreEffectKind.RecordingSinkDiscard -> {
                    prepared -= sinkId
                    registry.remove(sinkId, discard = true)
                }
                else -> throw NativeHostException(422, "non-recording effect reached recording sink")
            }
        }
    }.flowOn(Dispatchers.IO)

    override fun close() {
        prepared.clear()
        registry.close()
    }

    private fun requirePrepared(sinkId: String) {
        if (sinkId !in prepared) throw NativeHostException(409, "recording sink was not prepared")
    }

    private fun crc32(resource: FileResource): Long {
        val checksum = CRC32()
        resource.openRead().use { channel ->
            val buffer = ByteBuffer.allocate(64 * 1024)
            while (channel.read(buffer) >= 0) {
                if (buffer.position() == 0) continue
                checksum.update(buffer.array(), 0, buffer.position())
                buffer.clear()
            }
        }
        return checksum.value
    }

    private companion object {
        val FileChannelSize: (java.nio.channels.FileChannel) -> ULong = { it.size().toULong() }
    }
}

internal fun ULong.toLongChecked(): Long {
    if (this > Long.MAX_VALUE.toULong()) throw NativeHostException(422, "file offset is too large")
    return toLong()
}

