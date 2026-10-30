package dev.bota.sdk.localwifi

import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket

/** Local test peer only; all keys are generated in a temporary directory by the runner. */
private class Peer(store: String, protocol: String = "TLSv1.3", private val reply: String, private val stall: Boolean = false) : AutoCloseable {
    val request = CompletableFuture<String>()
    private val release = CountDownLatch(1)
    private val server: SSLServerSocket
    private val worker: Thread
    val port: Int get() = server.localPort
    init {
        val keys = KeyStore.getInstance("PKCS12").apply { File(store).inputStream().use { load(it, "test-only".toCharArray()) } }
        val managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(keys, "test-only".toCharArray()) }
        val context = SSLContext.getInstance("TLS").apply { init(managers.keyManagers, null, null) }
        server = context.serverSocketFactory.createServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress()) as SSLServerSocket
        server.enabledProtocols = arrayOf(protocol)
        worker = Thread {
            try {
                (server.accept() as SSLSocket).use { socket ->
                    socket.soTimeout = 5_000
                    val input = socket.inputStream
                    val headers = StringBuilder()
                    while (!headers.endsWith("\r\n\r\n")) {
                        val next = input.read()
                        check(next >= 0 && headers.length < 16_384)
                        headers.append(next.toChar())
                    }
                    request.complete(headers.toString())
                    socket.outputStream.write(reply.toByteArray(Charsets.US_ASCII))
                    socket.outputStream.flush()
                    if (stall) check(release.await(5, TimeUnit.SECONDS))
                }
            } catch (error: Exception) { request.completeExceptionally(error) }
        }.apply { isDaemon = true; start() }
    }
    override fun close() { release.countDown(); server.close(); worker.join(6_000); check(!worker.isAlive) }
}

fun main(args: Array<String>) {
    val certificate = File(args[0]).inputStream().use { CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate }
    val pin = MessageDigest.getInstance("SHA-256").digest(certificate.publicKey.encoded)
    val good = LocalWiFiHTTP.pinnedTrust(pin)
    good.checkServerTrusted(arrayOf(certificate), "EC")
    try { LocalWiFiHTTP.pinnedTrust(ByteArray(32)).checkServerTrusted(arrayOf(certificate), "EC"); error("Wrong pin accepted") }
    catch (_: java.security.cert.CertificateException) { }
    try { good.checkServerTrusted(emptyArray(), "EC"); error("Empty chain accepted") }
    catch (_: java.security.cert.CertificateException) { }
    fun reader(peer: Peer, key: ByteArray = pin): LocalWiFiHTTP = LocalWiFiHTTP(
        SocketFactory.getDefault(), "127.0.0.1", peer.port, key, System.nanoTime() + TimeUnit.SECONDS.toNanos(15))
    val body = "x".repeat(65_537)
    Peer(args[1], reply = "HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nETag: \"test\"\r\n\r\n$body").use { peer ->
        reader(peer).use { http ->
            val headers = http.open("/recordings/test/1", "0", "\"test\"", "test_only")
            check(headers.status == 200 && headers.values["content-length"] == body.length.toString())
            var received = 0
            while (true) { val bytes = http.read(1024) ?: break; check(bytes.size in 1..1024 && bytes.all { it == 120.toByte() }); received += bytes.size }
            check(received == body.length)
            val request = peer.request.get(5, TimeUnit.SECONDS)
            check(request.contains("Authorization: Bearer test_only\r\n") && request.contains("Accept-Encoding: identity\r\n"))
            check(!request.contains("Range:") && !request.contains("If-Match:"))
        }
    }
    Peer(args[1], reply = "HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nContent-Range: bytes 2-4/5\r\nETag: \"test\"\r\n\r\nxyz").use { peer ->
        reader(peer).use { http ->
            check(http.open("/recordings/test/1", "2", "\"test\"", "test_only").status == 206)
            check(http.read(65536)!!.toString(Charsets.US_ASCII) == "xyz" && http.read(1) == null)
            check(peer.request.get(5, TimeUnit.SECONDS).contains("Range: bytes=2-\r\nIf-Match: \"test\"\r\n"))
        }
    }
    for (protocol in listOf("TLSv1.2", "TLSv1.3")) {
        Peer(args[1], protocol, reply = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").use { peer ->
            reader(peer, if (protocol == "TLSv1.3") ByteArray(32) else pin).use { http ->
                val result = runCatching { http.open("/recordings/test/1", "0", "test", "test_only") }
                check(result.isFailure) { "Untrusted pin or TLS downgrade accepted" }
            }
        }
    }
    Peer(args[1], reply = "HTTP/1.1 302 Found\r\nContent-Length: 0\r\nLocation: https://127.0.0.1:1/leak\r\n\r\n").use { peer ->
        reader(peer).use { http -> check(http.open("/recordings/test/1", "0", "test", "test_only").status == 302) }
    }
    for (extra in listOf("Transfer-Encoding: chunked\r\n", "Content-Length: 1\r\n")) {
        Peer(args[1], reply = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n${extra}\r\n").use { peer ->
            reader(peer).use { http -> check(runCatching { http.open("/recordings/test/1", "0", "test", "test_only") }.isFailure) }
        }
    }
    Peer(args[1], reply = "HTTP/1.1 200 OK\r\nContent-Length: +1\r\n\r\nx").use { peer ->
        reader(peer).use { http -> check(runCatching { http.open("/recordings/test/1", "0", "test", "test_only") }.isFailure) }
    }
    // The server withholds the body. Closing must abort and join the real blocked reader.
    Peer(args[1], reply = "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n", stall = true).use { peer ->
        val http = reader(peer)
        http.open("/recordings/test/1", "0", "test", "test_only")
        val entered = CountDownLatch(1)
        val read = CompletableFuture.supplyAsync { entered.countDown(); runCatching { http.read(10) } }
        check(entered.await(5, TimeUnit.SECONDS))
        val closing = CompletableFuture.runAsync { http.close() }
        closing.get(5, TimeUnit.SECONDS)
        check(read.get(5, TimeUnit.SECONDS).isFailure)
        http.close()
    }
    // Cancel while waiting for headers, after the peer confirms request receipt.
    Peer(args[1], reply = "", stall = true).use { peer ->
        val http = reader(peer)
        val opening = CompletableFuture.supplyAsync { runCatching { http.open("/recordings/test/1", "0", "test", "test_only") } }
        peer.request.get(5, TimeUnit.SECONDS)
        CompletableFuture.runAsync { http.close() }.get(5, TimeUnit.SECONDS)
        check(opening.get(5, TimeUnit.SECONDS).isFailure)
    }
    println("Android TLS 1.3, pin refusal, Range, bounded reads, redirect refusal, framing and joined cancellation checks passed")
}
