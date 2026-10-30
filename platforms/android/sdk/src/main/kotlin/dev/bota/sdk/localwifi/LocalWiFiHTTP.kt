package dev.bota.sdk.localwifi

import android.annotation.SuppressLint
import java.io.Closeable
import java.net.Proxy
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import javax.net.SocketFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.withLock
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.ConnectionSpec
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.TlsVersion

/** One immutable HTTPS reader. Call blocking methods on IO workers; close joins those workers.
 * The supplied socket factory must belong to the acquired Android Network, never the process default.
 * Only a leaf SPKI pin received over an authenticated encrypted BLE link is trusted.
 */
public class LocalWiFiHTTP(
    socketFactory: SocketFactory,
    private val ipv4: String,
    private val port: Int,
    spkiSHA256: ByteArray,
    private val deadlineNanos: Long,
) : Closeable {
    public class Headers(public val status: Int, public val values: Map<String, String>)
    private val lock = ReentrantLock()
    private val idle = lock.newCondition()
    private var active = 0
    private var opened = false
    private var closed = false
    private var call: Call? = null
    private var response: Response? = null
    private var reading = false
    private val client: OkHttpClient

    init {
        require(ipv4.split('.').let { parts -> parts.size == 4 && parts.all { part ->
            part.toIntOrNull()?.let { it in 0..255 && it.toString() == part } == true
        } })
        require(port in 1..65535)
        val trust = pinnedTrust(spkiSHA256.copyOf())
        val tls = SSLContext.getInstance("TLSv1.3").apply { init(null, arrayOf(trust), null) }
        client = OkHttpClient.Builder().socketFactory(socketFactory).sslSocketFactory(tls.socketFactory, trust)
            .hostnameVerifier { hostname, _ -> hostname == ipv4 }
            .connectionSpecs(listOf(ConnectionSpec.Builder(ConnectionSpec.MODERN_TLS).tlsVersions(TlsVersion.TLS_1_3).build()))
            .protocols(listOf(Protocol.HTTP_1_1)).proxy(Proxy.NO_PROXY)
            .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
    public fun open(path: String, offset: String, etag: String, bearer: String): Headers {
        require(path.startsWith('/') && !path.startsWith("//") && path.all { it.code in 33..126 && it != '#' })
        require(offset.matches(Regex("0|[1-9][0-9]*")) && offset.toULongOrNull() != null)
        require(bearer.matches(Regex("[A-Za-z0-9_-]+")))
        require(etag.all { it.code in 32..126 })
        val request = Request.Builder().url("https://$ipv4:$port$path")
            .header("Authorization", "Bearer $bearer").header("Accept-Encoding", "identity")
            .header("Connection", "close")
        if (offset != "0") request.header("Range", "bytes=$offset-").header("If-Match", etag)
        val owned = lock.withLock {
            check(!closed && !opened && deadlineNanos > System.nanoTime())
            opened = true; active++
            client.newCall(request.build()).also { call = it; it.timeout().deadlineNanoTime(deadlineNanos) }
        }
        try {
            val result = owned.execute()
            lock.withLock {
                if (closed) { result.close(); error("Local WiFi reader closed") }
                response = result
            }
            val headers = mutableMapOf<String, String>()
            for (name in result.headers.names()) {
                val values = result.headers.values(name)
                check(values.size == 1) { "Ambiguous local HTTP headers" }
                headers[name.lowercase()] = values.single()
            }
            val length = headers["content-length"]
            check(headers["transfer-encoding"] == null && length != null && length.isNotEmpty() &&
                length.all { it in '0'..'9' } && length.toULongOrNull() != null)
            return Headers(result.code, headers)
        } catch (error: Throwable) {
            owned.cancel()
            lock.withLock { response?.close(); response = null }
            throw error
        } finally { finished() }
    }
    public fun read(maximumLength: Int): ByteArray? {
        require(maximumLength in 1..65536)
        val source = lock.withLock {
            check(!closed && !reading && deadlineNanos > System.nanoTime())
            val source = checkNotNull(response?.body).source()
            reading = true; active++; source
        }
        try {
            val bytes = ByteArray(maximumLength)
            val length = source.read(bytes)
            return if (length == -1) null else bytes.copyOf(length)
        } finally { lock.withLock { reading = false }; finished() }
    }
    override fun close() {
        val owned = lock.withLock { closed = true; call }
        owned?.cancel()
        lock.withLock {
            while (active != 0) idle.awaitUninterruptibly()
            response?.close(); response = null; call = null
        }
        client.connectionPool.evictAll()
        client.dispatcher.executorService.shutdown()
    }
    private fun finished() { lock.withLock { active--; idle.signalAll() } }
    public companion object {
        // Trust is the exact protected-BLE leaf SPKI pin; platform CA fallback is forbidden.
        @SuppressLint("CustomX509TrustManager")
        internal fun pinnedTrust(pin: ByteArray): X509TrustManager {
            require(pin.size == 32)
            return object : X509TrustManager {
                override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
                override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                    throw CertificateException("Client authentication is unsupported")
                }
                override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                    val leaf = chain?.firstOrNull() ?: throw CertificateException("Missing peer certificate")
                    val actual = MessageDigest.getInstance("SHA-256").digest(leaf.publicKey.encoded)
                    if (!MessageDigest.isEqual(actual, pin)) throw CertificateException("Local peer pin mismatch")
                }
            }
        }
    }
}
