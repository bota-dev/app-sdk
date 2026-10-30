package dev.bota.sdk.reactnative.localwifi

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.common.LifecycleState
import dev.bota.sdk.localwifi.LocalWiFiHTTP
import dev.bota.sdk.localwifi.LocalWiFiNetwork
import dev.bota.sdk.reactnative.NativeBotaLocalWifiTransportSpec
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import org.json.JSONObject

/** One foreground OS lease; the generated Rust/JS host owns all workflow policy. */
internal class BotaLocalWifiTransportModule(private val context: ReactApplicationContext) :
    NativeBotaLocalWifiTransportSpec(context), LifecycleEventListener {
    private val registry = Any()
    private val workers = Executors.newCachedThreadPool()
    private var current: Entry? = null
    @Volatile private var destroyed = false
    @Volatile private var resumed = context.lifecycleState == LifecycleState.RESUMED

    private class Entry(val id: String) {
        val lock = ReentrantLock()
        val idle = lock.newCondition()
        var retiring = false
        var readerRetiring = false
        var joined = false
        var joining = false
        var opened = false
        var readerActive = false
        var deadline = 0L
        var network: LocalWiFiNetwork? = null
        var http: LocalWiFiHTTP? = null
        fun retire() { lock.withLock { retiring = true; readerRetiring = true } }
        fun closeReader() {
            val captured = lock.withLock { readerRetiring = true; http }
            captured?.close()
            lock.withLock {
                while (readerActive) idle.awaitUninterruptibly()
                http = null
            }
        }
        fun close() {
            retire()
            closeReader()
            val captured = lock.withLock { network }
            captured?.close()
            lock.withLock {
                while (joining) idle.awaitUninterruptibly()
                network = null
            }
        }
        fun <T> reading(make: (() -> LocalWiFiHTTP)? = null, body: (LocalWiFiHTTP) -> T): T {
            val reader = lock.withLock {
                check(!retiring && !readerRetiring && !readerActive && joined)
                if (make != null) { check(!opened); opened = true; http = make() }
                val reader = checkNotNull(http)
                readerActive = true
                reader
            }
            try {
                val result = body(reader)
                lock.withLock { check(!retiring && !readerRetiring) }
                return result
            }
            finally { lock.withLock { readerActive = false; idle.signalAll() } }
        }
    }
    init { context.addLifecycleEventListener(this) }
    override fun getName(): String = NAME
    private fun foreground() {
        check(!destroyed && resumed && Build.VERSION.SDK_INT >= 29 && context.lifecycleState == LifecycleState.RESUMED)
        val permissions = listOf(Manifest.permission.INTERNET, Manifest.permission.ACCESS_NETWORK_STATE,
            Manifest.permission.CHANGE_NETWORK_STATE, Manifest.permission.ACCESS_WIFI_STATE, Manifest.permission.CHANGE_WIFI_STATE,
            if (Build.VERSION.SDK_INT >= 33 && context.applicationInfo.targetSdkVersion >= 33)
                Manifest.permission.NEARBY_WIFI_DEVICES else Manifest.permission.ACCESS_FINE_LOCATION)
        check(permissions.all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED })
    }
    private fun invoke(promise: Promise, action: () -> Any?) {
        try { workers.execute {
            try { promise.resolve(action()) }
            catch (_: Exception) { promise.reject("local_wifi_unavailable", "Local WiFi operation failed") }
        } } catch (_: Exception) { promise.reject("local_wifi_unavailable", "Local WiFi transport unavailable") }
    }
    private fun entry(id: String): Entry = synchronized(registry) { checkNotNull(current?.takeIf { it.id == id }) }
    private fun input(json: String): JSONObject { require(json.length <= 4096); return JSONObject(json) }
    override fun preflight(promise: Promise) = invoke(promise) {
        synchronized(registry) { foreground(); check(current == null) }; null
    }
    override fun createLease(promise: Promise) = invoke(promise) {
        foreground()
        synchronized(registry) {
            foreground()
            check(!destroyed && current == null)
            Entry(UUID.randomUUID().toString()).also { current = it }.id
        }
    }
    override fun join(handle: String, inputJSON: String, promise: Promise) = invoke(promise) {
        foreground()
        val data = input(inputJSON)
        val remaining = data.getDouble("remainingMs")
        require(remaining.isFinite() && remaining > 0 && remaining <= 4_294_967_295_000.0)
        val owner = entry(handle)
        val network = owner.lock.withLock {
            check(!owner.retiring && !owner.joining && owner.network == null && !owner.joined)
            owner.deadline = System.nanoTime() + (remaining * 1_000_000).toLong()
            LocalWiFiNetwork.join(context, data.getString("ssid"), data.getString("password")).also {
                owner.network = it; owner.joining = true
            }
        }
        try {
            network.ready.get()
            foreground()
            owner.lock.withLock { check(!owner.retiring && System.nanoTime() < owner.deadline); owner.joined = true }
        } finally { owner.lock.withLock { owner.joining = false; owner.idle.signalAll() } }
        null
    }
    override fun open(handle: String, inputJSON: String, promise: Promise) = invoke(promise) {
        foreground()
        val data = input(inputJSON)
        val pinHex = data.getString("spkiHex")
        require(pinHex.matches(Regex("[0-9a-f]{64}")))
        val pin = pinHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val owner = entry(handle)
        owner.reading(make = {
            checkNotNull(owner.network).reader(data.getString("ipv4"), data.getInt("port"), pin, owner.deadline)
        }) { reader ->
            val response = reader.open(data.getString("path"), data.getString("offset"), data.getString("etag"), data.getString("bearer"))
            val result = JSONObject().put("status", response.status).put("headers", JSONObject(response.values)).toString()
            check(result.length <= 32_768)
            result
        }
    }
    override fun read(handle: String, maximumLength: Double, promise: Promise) = invoke(promise) {
        foreground()
        require(maximumLength.isFinite() && maximumLength == maximumLength.toInt().toDouble() && maximumLength in 1.0..65536.0)
        entry(handle).reading { reader -> reader.read(maximumLength.toInt())?.let { Base64.encodeToString(it, Base64.NO_WRAP) } }
    }
    override fun closeReader(handle: String, promise: Promise) = invoke(promise) {
        synchronized(registry) { current?.takeIf { it.id == handle } }?.closeReader(); null
    }
    private fun close(handle: String) {
        val captured = synchronized(registry) { current?.takeIf { it.id == handle } } ?: return
        captured.close()
        synchronized(registry) { if (current === captured) current = null }
    }
    override fun closeLease(handle: String, promise: Promise) = invoke(promise) { close(handle); null }
    private fun retireCurrent() {
        val captured = synchronized(registry) { current?.also { it.retire() } } ?: return
        try { workers.execute {
            try { close(captured.id) } catch (_: Exception) { /* Retain the handle for explicit cleanup retry. */ }
        } } catch (_: RejectedExecutionException) {
            // Invalidation already submitted its captured cleanup before shutdown.
        }
    }
    override fun onHostResume() { resumed = true }
    override fun onHostPause() { resumed = false; retireCurrent() }
    override fun onHostDestroy() { resumed = false; retireCurrent() }
    override fun invalidate() {
        destroyed = true
        context.removeLifecycleEventListener(this)
        retireCurrent()
        workers.shutdown()
        super.invalidate()
    }
    companion object { const val NAME = "BotaLocalWifiTransport" }
}
