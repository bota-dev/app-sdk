package dev.bota.sdk.internal.host

import dev.bota.sdk.internal.core.CoreEffectKind
import dev.bota.sdk.internal.core.CoreField
import dev.bota.sdk.internal.core.HostEventKind
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.ResponseBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.BufferedSource
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkHostTest {
    @Test
    fun downloadStreamsProgressClosesBodyAndConsumesRegistration() = runTest {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("firmware"))
        server.start()
        val closed = AtomicBoolean(false)
        val host = OkHttpNetworkHost(client(closed))
        val destination = Files.createTempFile("bota-download", ".bin")
        host.registerDownload(7u, Request.Builder().url(server.url("/firmware")).build(), destination)

        val events = host.execute(
            hostEffect(CoreEffectKind.NetworkDownload, CoreField.Unsigned(21, 7u)),
        ).toList()

        assertArrayEquals("firmware".encodeToByteArray(), Files.readAllBytes(destination))
        assertEquals(HostEventKind.NetworkDownloadCompleted, events.last().kind)
        assertEquals(0xd5ecd7c4uL, events.last().unsigned(20))
        assertEquals(events.mapNotNull { it.unsigned(36) }.sorted(), events.mapNotNull { it.unsigned(36) })
        assertTrue(closed.get())
        assertFalse(host.hasRegistration(7u))
        server.close()
    }

    @Test
    fun uploadUsesOnlyRegisteredSourceAndReportsCompletion() = runTest {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(200))
        server.start()
        val source = Files.createTempFile("bota-upload", ".ogg")
        Files.write(source, "recording".encodeToByteArray())
        val host = OkHttpNetworkHost()
        host.registerUpload(
            11u,
            Request.Builder().url(server.url("/upload")).put(byteArrayOf().toRequestBody()).build(),
            source,
        )

        val events = host.execute(
            hostEffect(CoreEffectKind.NetworkUpload, CoreField.Unsigned(16, 11u)),
        ).toList()

        assertEquals("recording", server.takeRequest().body.readUtf8())
        assertEquals(HostEventKind.NetworkUploadCompleted, events.last().kind)
        server.close()
    }

    @Test
    fun replacingTransferIdUsesTheLatestFileRegistration() = runTest {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("latest"))
        server.start()
        val first = Files.createTempFile("bota-replaced", ".bin")
        val latest = Files.createTempFile("bota-latest", ".bin")
        val host = OkHttpNetworkHost()
        val request = Request.Builder().url(server.url("/download")).build()
        host.registerDownload(19u, request, first)
        host.registerDownload(19u, request, latest)

        host.execute(hostEffect(CoreEffectKind.NetworkDownload, CoreField.Unsigned(21, 19u))).toList()

        assertEquals(0, Files.size(first))
        assertArrayEquals("latest".encodeToByteArray(), Files.readAllBytes(latest))
        server.close()
    }

    @Test
    fun cancellationCancelsCallAndRemovesRegistration() = runTest {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("slow").setBodyDelay(5, TimeUnit.SECONDS))
        server.start()
        val destination = Files.createTempFile("bota-cancel", ".bin")
        val host = OkHttpNetworkHost()
        host.registerDownload(13u, Request.Builder().url(server.url("/slow")).build(), destination)
        val collection = async(start = CoroutineStart.UNDISPATCHED) {
            host.execute(hostEffect(CoreEffectKind.NetworkDownload, CoreField.Unsigned(21, 13u))).toList()
        }
        server.takeRequest(1, TimeUnit.SECONDS)

        collection.cancelAndJoin()

        assertFalse(host.hasRegistration(13u))
        server.close()
    }

    private fun client(closed: AtomicBoolean): OkHttpClient = OkHttpClient.Builder()
        .addNetworkInterceptor(
            Interceptor { chain ->
                val response = chain.proceed(chain.request())
                val body = requireNotNull(response.body)
                response.newBuilder().body(
                    object : ResponseBody() {
                        override fun contentType(): MediaType? = body.contentType()
                        override fun contentLength(): Long = body.contentLength()
                        override fun source(): BufferedSource = body.source()
                        override fun close() {
                            closed.set(true)
                            body.close()
                        }
                    },
                ).build()
            },
        )
        .build()
}
