package dev.bota.sdk.reactnative.localwifi

import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

internal class BotaBleSessionModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    override fun getName() = NAME
    private val main = Handler(Looper.getMainLooper())
    private val delays = mutableMapOf<String, Runnable>()
    private val activation = mutableListOf<Promise>()
    private var started = false
    private var starting = false
    private var wanted = false

    private fun release(token: String) {
        delays[token]?.let { main.removeCallbacks(it); it.run() }
    }

    @ReactMethod
    fun waitToRetryFor(token: String, ms: Double, promise: Promise) {
        main.post {
            if (!started || token in delays || !ms.isFinite() || ms !in 0.0..30000.0) {
                promise.reject("ble_retry_unavailable", "No active Bluetooth session for retry")
            } else {
                val finish = Runnable { delays.remove(token); promise.resolve(null) }
                delays[token] = finish
                main.postDelayed(finish, ms.toLong())
            }
        }
    }

    @ReactMethod
    fun cancelRetry(token: String, promise: Promise) {
        main.post { release(token); promise.resolve(null) }
    }

    private fun stop() {
        wanted = false
        delays.keys.toList().forEach(::release)
        activation.forEach { it.reject("ble_session_cancelled", "Bluetooth session stopped") }
        activation.clear()
        if (started) context.stopService(Intent(context, BotaBleSessionService::class.java))
        started = false
    }

    @ReactMethod
    fun setActive(active: Boolean, promise: Promise) {
        main.post {
            if (!active) { stop(); promise.resolve(null); return@post }
            wanted = true
            if (started) { promise.resolve(null); return@post }
            activation.add(promise)
            if (starting) return@post
            starting = true
            val confirmed: (RuntimeException?) -> Unit = { failure ->
                starting = false
                started = failure == null
                if (!wanted) stop()
                activation.forEach {
                    if (failure == null) it.resolve(null)
                    else it.reject("ble_session_service_unavailable", failure)
                }
                activation.clear()
            }
            BotaBleSessionService.onPromotion = confirmed
            try { context.startForegroundService(Intent(context, BotaBleSessionService::class.java)) }
            catch (error: RuntimeException) {
                BotaBleSessionService.onPromotion = null
                confirmed(error)
            }
        }
    }

    override fun invalidate() {
        main.post { stop() }
        super.invalidate()
    }

    companion object { const val NAME = "BotaBleSession" }
}
