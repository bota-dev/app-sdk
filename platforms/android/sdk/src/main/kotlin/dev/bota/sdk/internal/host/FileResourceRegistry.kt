package dev.bota.sdk.internal.host

import android.os.ParcelFileDescriptor
import java.io.Closeable
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption

internal interface FileResource : Closeable {
    fun openRead(): FileChannel
    fun openWrite(): FileChannel
    fun discard()
}

internal class FileResourceRegistry : AutoCloseable {
    private val lock = Any()
    private val resources = mutableMapOf<String, FileResource>()

    fun registerPath(id: String, path: Path) = register(id, PathFileResource(path))

    fun registerDescriptor(id: String, descriptor: ParcelFileDescriptor) =
        register(id, ParcelFileDescriptorResource(descriptor))

    fun register(id: String, resource: FileResource) {
        synchronized(lock) { resources.put(validOpaqueId(id), resource) }?.close()
    }

    fun resource(id: String): FileResource = synchronized(lock) { resources[id] }
        ?: throw NativeHostException(404, "file resource is not registered")

    fun remove(id: String, discard: Boolean = false) {
        val resource = synchronized(lock) { resources.remove(id) } ?: return
        if (discard) resource.discard()
        resource.close()
    }

    override fun close() {
        val values = synchronized(lock) { resources.values.toList().also { resources.clear() } }
        values.forEach(FileResource::close)
    }
}

private class PathFileResource(private val path: Path) : FileResource {
    override fun openRead(): FileChannel = FileChannel.open(path, StandardOpenOption.READ)

    override fun openWrite(): FileChannel {
        path.parent?.let(Files::createDirectories)
        return FileChannel.open(path, StandardOpenOption.CREATE, StandardOpenOption.WRITE)
    }

    override fun discard() {
        Files.deleteIfExists(path)
    }

    override fun close() = Unit
}

private class ParcelFileDescriptorResource(private val descriptor: ParcelFileDescriptor) : FileResource {
    override fun openRead(): FileChannel =
        ParcelFileDescriptor.AutoCloseInputStream(ParcelFileDescriptor.dup(descriptor.fileDescriptor)).channel

    override fun openWrite(): FileChannel =
        ParcelFileDescriptor.AutoCloseOutputStream(ParcelFileDescriptor.dup(descriptor.fileDescriptor)).channel

    override fun discard() {
        openWrite().use { channel ->
            channel.truncate(0)
            channel.force(true)
        }
    }

    override fun close() = descriptor.close()
}
