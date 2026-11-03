package dev.bota.speech.companion

import kotlinx.coroutines.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class NativeLabTransportTest {
    private fun request(server: MockWebServer) = LabRequest(server.url("/speech-host/join").toString(), mapOf(
        "Origin" to "http://127.0.0.1:${server.port}", "Content-Type" to "application/json",
        "X-Speech-Role" to "a", "X-Speech-Code" to "a".repeat(40)), "{}")
    @Test fun realHttpCarriesOnlyRoleCredentialsAndRefusesRedirects() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val transport = NativeLabTransport()
            try {
                server.enqueue(MockResponse().setResponseCode(202).setBody("pending"))
                val response = withTimeout(5000) { transport.send(request(server)) }
                assertEquals(202, response.status); assertEquals("pending", response.body)
                val sent = requireNotNull(server.takeRequest(5, TimeUnit.SECONDS))
                assertEquals("{}", sent.body.readUtf8()); assertEquals("application/json", sent.getHeader("Content-Type"))
                assertNull(sent.getHeader("Authorization"))
                server.enqueue(MockResponse().setResponseCode(302).addHeader("Location", server.url("/redirect")))
                assertEquals(302, withTimeout(5000) { transport.send(request(server)) }.status)
                assertEquals(2, server.requestCount)
            } finally { transport.close() }
        }
    }
    @Test fun chunkedBodiesStayBoundedAndCancellationClosesOwnedRequest() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val transport = NativeLabTransport()
            try {
                server.enqueue(MockResponse().setChunkedBody("x".repeat(524_289), 8192))
                assertTrue(runCatching { withTimeout(5000) { transport.send(request(server)) } }.exceptionOrNull() is LabFailure)
                server.takeRequest(5, TimeUnit.SECONDS)
                server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
                val waiting = async(Dispatchers.Default) { transport.send(request(server)) }
                assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
                withTimeout(5000) { waiting.cancelAndJoin() }
                assertTrue(waiting.isCancelled)
            } finally { transport.close() }
        }
    }
}
