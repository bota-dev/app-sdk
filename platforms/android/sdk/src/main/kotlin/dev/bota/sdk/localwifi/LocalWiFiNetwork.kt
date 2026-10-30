package dev.bota.sdk.localwifi

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import java.io.Closeable
import java.util.concurrent.CompletableFuture
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Android 10+ foreground local-only network lease. The app owns runtime permission UI.
 * Never calls bindProcessToNetwork: cloud sockets retain their original routing.
 * Await ready before creating a reader, and always call close on an IO worker.
 */
public class LocalWiFiNetwork private constructor(
    private val manager: ConnectivityManager,
) : Closeable {
    public val ready: CompletableFuture<Network> = CompletableFuture()
    /** Reports asynchronous network-loss cleanup, including unregister failures. */
    public val termination: CompletableFuture<Void> = CompletableFuture()
    private val lock = ReentrantLock()
    private val idle = lock.newCondition()
    private var registered = false
    private var retiring = false
    private var closing = false
    private var closed = false
    private var network: Network? = null
    private val readers = mutableListOf<LocalWiFiHTTP>()
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(value: Network) {
            val accepted = lock.withLock {
                if (retiring || network != null) false else { network = value; true }
            }
            if (accepted) ready.complete(value)
        }
        override fun onUnavailable() {
            // Android has already released this request when onUnavailable is delivered.
            lock.withLock { registered = false }
            ready.completeExceptionally(IllegalStateException("Local network unavailable"))
            retire()
        }
        override fun onLost(value: Network) {
            if (lock.withLock { network == value }) retire()
        }
    }
    private fun retire() {
        val schedule = lock.withLock { if (retiring) false else { retiring = true; true } }
        if (schedule) {
            // Never join blocked socket reads on ConnectivityManager's callback thread.
            CompletableFuture.runAsync {
                try { close() } catch (error: Exception) { termination.completeExceptionally(error) }
            }
        }
    }
    public fun reader(ipv4: String, port: Int, pin: ByteArray, deadlineNanos: Long): LocalWiFiHTTP = lock.withLock {
        check(!retiring)
        LocalWiFiHTTP(checkNotNull(network).socketFactory, ipv4, port, pin, deadlineNanos).also { readers.add(it) }
    }
    override fun close() {
        lock.withLock { retiring = true }
        // CompletableFuture listeners can call close synchronously. Retire readiness
        // before claiming the close worker, so such a listener cannot self-deadlock.
        ready.cancel(false)
        val captured = lock.withLock {
            while (closing) idle.awaitUninterruptibly()
            if (closed) return
            closing = true
            readers.toList()
        }
        try {
            captured.forEach { it.close() }
            lock.withLock {
                if (registered) { manager.unregisterNetworkCallback(callback); registered = false }
                readers.clear(); network = null; closed = true
            }
        } finally {
            // Failed unregister retains the original callback so a later close can retry.
            lock.withLock { closing = false; idle.signalAll() }
        }
        termination.complete(null)
    }
    public companion object {
        public fun join(context: Context, ssid: String, password: String): LocalWiFiNetwork {
            if (Build.VERSION.SDK_INT < 29) throw IllegalStateException("Local WiFi requires Android 10 or newer")
            require(ssid.toByteArray(Charsets.UTF_8).size in 1..32)
            require(password.length in 8..63 && password.all { it.code in 32..126 })
            val manager = requireNotNull(context.getSystemService(ConnectivityManager::class.java))
            val lease = LocalWiFiNetwork(manager)
            val specifier = WifiNetworkSpecifier.Builder().setSsid(ssid).setWpa2Passphrase(password).build()
            val request = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).setNetworkSpecifier(specifier).build()
            lease.lock.withLock {
                try {
                    manager.requestNetwork(request, lease.callback, 30_000)
                    lease.registered = true
                } catch (error: Exception) { lease.retiring = true; lease.closed = true; throw error }
            }
            lease.ready.whenComplete { _, _ -> if (lease.ready.isCancelled) lease.retire() }
            return lease
        }
    }
}
