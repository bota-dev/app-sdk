package dev.bota.sdk.reactnative.security

internal enum class BleBondState { None, Bonding, Bonded }

internal interface BleBondPlatform {
    fun state(address: String): BleBondState
    fun start(address: String): Boolean
    fun observe(listener: (String, BleBondState) -> Unit, failed: (String) -> Unit): AutoCloseable
    fun after(milliseconds: Long, action: () -> Unit): AutoCloseable
}

/** Called on one OS handler. Pairing completion is not proof of link encryption. */
internal class BleBonding(private val platform: BleBondPlatform) {
    private class Request(val address: String, val complete: (String?) -> Unit) {
        var receiver: AutoCloseable? = null
        var timer: AutoCloseable? = null
    }
    private val requests = mutableMapOf<String, Request>()
    private var closed = false

    fun request(address: String, id: String, timeoutMs: Long, complete: (String?) -> Unit) {
        if (closed || id.isEmpty() || timeoutMs !in 1..120_000) {
            complete("ble_security_unavailable")
            return
        }
        if (requests.containsKey(id) || requests.values.any { it.address == address }) {
            complete("ble_pairing_busy")
            return
        }
        val request = Request(address, complete)
        requests[id] = request
        fun finish(code: String?) = finish(id, request, code)
        try {
            request.receiver = platform.observe({ device, state ->
                if (device == address) {
                    when (state) {
                        BleBondState.Bonded -> finish(null)
                        BleBondState.None -> finish("ble_pairing_rejected")
                        BleBondState.Bonding -> Unit
                    }
                }
            }, ::finish)
            if (requests[id] !== request) { request.receiver?.close(); return }
            request.timer = platform.after(timeoutMs) { finish("ble_security_timeout") }
            if (requests[id] !== request) { request.timer?.close(); return }
            when (platform.state(address)) {
                BleBondState.Bonded -> finish(null)
                BleBondState.Bonding -> Unit
                BleBondState.None -> if (!platform.start(address)) finish("ble_pairing_failed")
            }
        } catch (_: SecurityException) {
            finish("ble_permission_required")
        } catch (_: Exception) {
            finish("ble_pairing_failed")
        }
    }

    private fun finish(id: String, request: Request, code: String?) {
        if (requests[id] !== request) return
        requests.remove(id)
        var result = code
        for (resource in listOf(request.receiver, request.timer)) {
            try { resource?.close() } catch (_: Exception) { result = "ble_security_cleanup_failed" }
        }
        request.complete(result)
    }

    fun cancel(id: String) {
        requests[id]?.let { finish(id, it, "cancelled") }
    }

    fun close() {
        closed = true
        requests.keys.toList().forEach(::cancel)
    }
}
