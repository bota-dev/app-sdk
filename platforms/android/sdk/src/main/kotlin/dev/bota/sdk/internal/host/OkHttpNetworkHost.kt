package dev.bota.sdk.internal.host

import android.os.ParcelFileDescriptor
import dev.bota.sdk.internal.core.CoreEffect
import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.HostEventKind
import java.nio.ByteBuffer
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.launch
import okhttp3.Call
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink

internal class OkHttpNetworkHost(
    private val client: OkHttpClient = OkHttpClient(),
    private val registry: FileResourceRegistry = FileResourceRegistry(),
) : NetworkHost, AutoCloseable {
    private sealed interface Registration {
        val request: Request
        val resourceId: String

        data class Download(override val request: Request, override val resourceId: String) : Registration
        data class Upload(override val request: Request, override val resourceId: String) : Registration
    }

    private val lock = Any()
    private val registrations = mutableMapOf<ULong, Registration>()
    private val activeCalls = mutableSetOf<Call>()
    private var closed = false

    fun registerDownload(id: ULong, request: Request, destination: Path) {
        val resourceId = resourceId(id)
        replaceRegistration(id) {
            registry.registerPath(resourceId, destination)
            Registration.Download(request, resourceId)
        }
    }

    fun registerDownload(id: ULong, request: Request, destination: ParcelFileDescriptor) {
        val resourceId = resourceId(id)
        replaceRegistration(id) {
            registry.registerDescriptor(resourceId, destination)
            Registration.Download(request, resourceId)
        }
    }

    fun registerUpload(id: ULong, request: Request, source: Path) {
        val resourceId = resourceId(id)
        replaceRegistration(id) {
            registry.registerPath(resourceId, source)
            Registration.Upload(request, resourceId)
        }
    }

    fun registerUpload(id: ULong, request: Request, source: ParcelFileDescriptor) {
        val resourceId = resourceId(id)
        replaceRegistration(id) {
            registry.registerDescriptor(resourceId, source)
            Registration.Upload(request, resourceId)
        }
    }

    fun unregister(id: ULong) {
        synchronized(lock) { registrations.remove(id) }?.let { registry.remove(it.resourceId) }
    }

    fun hasRegistration(id: ULong): Boolean = synchronized(lock) { id in registrations }

    override fun execute(effect: CoreEffect): Flow<CoreHostEventPayload> = when (effect.kind) {
        CoreEffectKind.NetworkDownload -> download(effect)
        CoreEffectKind.NetworkUpload -> upload(effect)
        else -> channelFlow { close(NativeHostException(422, "non-network effect reached network host")) }
    }

    override fun close() {
        val (values, calls) = synchronized(lock) {
            closed = true
            val values = registrations.values.toList()
            registrations.clear()
            val calls = activeCalls.toList()
            activeCalls.clear()
            values to calls
        }
        values.forEach { registry.remove(it.resourceId) }
        calls.forEach(Call::cancel)
    }

    private fun download(effect: CoreEffect): Flow<CoreHostEventPayload> = channelFlow {
        val id = requiredUnsigned(effect, HostFieldId.DownloadId)
        val registration = take<Registration.Download>(id)
        val call = AtomicReference<Call>()
        val job = launch(Dispatchers.IO) {
            try {
                send(downloadProgress(id, 0u, null))
                val networkCall = client.newCall(registration.request).also {
                    track(it)
                    call.set(it)
                }
                networkCall.execute().use { response ->
                    validate(response.code)
                    val body = response.body ?: throw NativeHostException(502, "download response has no body")
                    val total = body.contentLength().takeIf { it >= 0 }?.toULong()
                    registry.resource(registration.resourceId).openWrite().use { channel ->
                        channel.truncate(0)
                        channel.position(0)
                        body.byteStream().use { input ->
                            val bytes = ByteArray(64 * 1024)
                            var completed = 0uL
                            while (true) {
                                val count = input.read(bytes)
                                if (count < 0) break
                                val buffer = ByteBuffer.wrap(bytes, 0, count)
                                while (buffer.hasRemaining()) channel.write(buffer)
                                completed += count.toULong()
                                send(downloadProgress(id, completed, total))
                            }
                        }
                        channel.force(true)
                    }
                }
                send(CoreHostEventPayload(HostEventKind.NetworkDownloadCompleted, listOf(CoreField.Unsigned(21, id))))
                close()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                close(error)
            } finally {
                call.get()?.let(::untrack)
                registry.remove(registration.resourceId)
            }
        }
        awaitClose {
            call.get()?.cancel()
            job.cancel()
            registry.remove(registration.resourceId)
        }
    }

    private fun upload(effect: CoreEffect): Flow<CoreHostEventPayload> = channelFlow {
        val id = requiredUnsigned(effect, HostFieldId.UploadId)
        val registration = take<Registration.Upload>(id)
        val call = AtomicReference<Call>()
        val resource = registry.resource(registration.resourceId)
        val total = resource.openRead().use { it.size().toULong() }
        val job = launch(Dispatchers.IO) {
            try {
                send(uploadProgress(id, 0u, total))
                val originalBody = registration.request.body
                val body = FileRequestBody(resource, originalBody?.contentType(), total) { completed ->
                    trySend(uploadProgress(id, completed, total))
                }
                val request = registration.request.newBuilder()
                    .method(registration.request.method, body)
                    .build()
                val networkCall = client.newCall(request).also {
                    track(it)
                    call.set(it)
                }
                networkCall.execute().use { response -> validate(response.code) }
                send(uploadProgress(id, total, total))
                send(CoreHostEventPayload(HostEventKind.NetworkUploadCompleted, listOf(CoreField.Unsigned(16, id))))
                close()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                close(error)
            } finally {
                call.get()?.let(::untrack)
                registry.remove(registration.resourceId)
            }
        }
        awaitClose {
            call.get()?.cancel()
            job.cancel()
            registry.remove(registration.resourceId)
        }
    }

    private inline fun <reified T : Registration> take(id: ULong): T {
        val registration = synchronized(lock) { registrations.remove(id) }
            ?: throw NativeHostException(404, "network transfer is not registered")
        if (registration !is T) {
            registry.remove(registration.resourceId)
            throw NativeHostException(409, "network transfer registration has the wrong direction")
        }
        return registration
    }

    private fun replaceRegistration(id: ULong, create: () -> Registration) {
        synchronized(lock) {
            if (closed) throw NativeHostException(409, "network host is closed")
            registrations.remove(id)?.let { registry.remove(it.resourceId) }
            registrations[id] = create()
        }
    }

    private fun track(call: Call) {
        synchronized(lock) {
            if (closed) {
                call.cancel()
                throw NativeHostException(409, "network host is closed")
            }
            activeCalls += call
        }
    }

    private fun untrack(call: Call) {
        synchronized(lock) { activeCalls -= call }
    }

    private fun validate(statusCode: Int) {
        if (statusCode !in 200..299) {
            throw NativeHostException(statusCode, "HTTP transfer failed with $statusCode", statusCode)
        }
    }

    private fun downloadProgress(id: ULong, completed: ULong, total: ULong?): CoreHostEventPayload =
        CoreHostEventPayload(
            HostEventKind.NetworkDownloadProgress,
            buildList {
                add(CoreField.Unsigned(HostFieldId.DownloadId, id))
                add(CoreField.Unsigned(HostFieldId.CompletedUnits, completed))
                total?.let { add(CoreField.Unsigned(15, it)) }
            },
        )

    private fun uploadProgress(id: ULong, completed: ULong, total: ULong): CoreHostEventPayload =
        CoreHostEventPayload(
            HostEventKind.NetworkUploadProgress,
            listOf(
                CoreField.Unsigned(HostFieldId.UploadId, id),
                CoreField.Unsigned(HostFieldId.CompletedUnits, completed),
                CoreField.Unsigned(15, total),
            ),
        )

    private fun resourceId(id: ULong): String = "network-$id"
}

private class FileRequestBody(
    private val resource: FileResource,
    private val mediaType: MediaType?,
    private val length: ULong,
    private val progress: (ULong) -> Unit,
) : RequestBody() {
    override fun contentType(): MediaType? = mediaType

    override fun contentLength(): Long = length.toLongChecked()

    override fun writeTo(sink: BufferedSink) {
        resource.openRead().use { channel ->
            val buffer = ByteBuffer.allocate(64 * 1024)
            var completed = 0uL
            while (channel.read(buffer) >= 0) {
                if (buffer.position() == 0) continue
                val count = buffer.position()
                sink.write(buffer.array(), 0, count)
                completed += count.toULong()
                progress(completed)
                buffer.clear()
            }
        }
    }
}
