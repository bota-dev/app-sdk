package dev.bota.sdk.internal.host

import android.os.ParcelFileDescriptor
import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.HostEventKind
import java.nio.ByteBuffer
import java.nio.file.Path
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn

internal class FileFirmwareBlobHost(
    private val maximumChunkLength: Int = UShort.MAX_VALUE.toInt(),
    private val registry: FileResourceRegistry = FileResourceRegistry(),
) : FirmwareBlobHost, AutoCloseable {
    private val ids = mutableMapOf<ULong, String>()

    fun registerPath(downloadId: ULong, path: Path) {
        val key = key(downloadId)
        registry.registerPath(key, path)
        synchronized(ids) { ids[downloadId] = key }
    }

    fun registerDescriptor(downloadId: ULong, descriptor: ParcelFileDescriptor) {
        val key = key(downloadId)
        registry.registerDescriptor(key, descriptor)
        synchronized(ids) { ids[downloadId] = key }
    }

    fun unregister(downloadId: ULong) {
        synchronized(ids) { ids.remove(downloadId) }?.let(registry::remove)
    }

    override fun execute(effect: CoreEffect): Flow<CoreHostEventPayload> = flow {
        if (effect.kind != CoreEffectKind.FirmwareBlobRead) {
            throw NativeHostException(422, "non-firmware effect reached firmware blob host")
        }
        val downloadId = requiredUnsigned(effect, HostFieldId.DownloadId)
        val offset = requiredUnsigned(effect, HostFieldId.Offset)
        val length = requiredUnsigned(effect, HostFieldId.MaximumLength)
        if (length == 0uL || length > maximumChunkLength.toULong()) {
            throw NativeHostException(422, "firmware read length is out of bounds")
        }
        val resourceId = synchronized(ids) { ids[downloadId] }
            ?: throw NativeHostException(404, "firmware blob is not registered")
        val bytes = registry.resource(resourceId).openRead().use { channel ->
            channel.position(offset.toLongChecked())
            val buffer = ByteBuffer.allocate(length.toInt())
            while (buffer.hasRemaining() && channel.read(buffer) > 0) Unit
            buffer.flip()
            ByteArray(buffer.remaining()).also(buffer::get)
        }
        emit(
            CoreHostEventPayload(
                HostEventKind.FirmwareChunkRead,
                listOf(
                    CoreField.Unsigned(HostFieldId.DownloadId, downloadId),
                    CoreField.Unsigned(HostFieldId.Offset, offset),
                    CoreField.Bytes(HostFieldId.Value, bytes),
                ),
            ),
        )
    }.flowOn(Dispatchers.IO)

    override fun close() {
        synchronized(ids) { ids.clear() }
        registry.close()
    }

    private fun key(downloadId: ULong): String = "firmware-$downloadId"
}
