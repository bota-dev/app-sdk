package dev.bota.sdk

import java.util.UUID

/** Passive metadata only. The host explicitly relays it through its authenticated heartbeat. */
public data class SDKClientContext(
    public val schemaVersion: Int,
    public val sessionId: String,
    public val sequence: Long,
    public val platform: String,
    public val sdkPackage: String,
    public val sdkVersion: String,
)

public class ClientPresence internal constructor(private val devices: DeviceManager) {
    /** No GATT reads or HTTP requests. Null without a current verified connection. */
    public suspend fun nextReport(deviceId: String): SDKClientContext? = devices.nextClientReport(deviceId)
}

/** Confined to DeviceManager's lock. Never persist this connection identity. */
internal class ConnectionClientPresence {
    var sessionId: String? = null
        private set
    var transportId: String? = null
        private set
    private var deviceId: String? = null
    private var sequence = 0L
    private var destroyed = false

    fun connected(deviceId: String, sessionId: String = UUID.randomUUID().toString(), transportId: String) {
        if (destroyed) return
        this.deviceId = deviceId
        this.sessionId = sessionId
        this.transportId = transportId
        sequence = 0
    }

    fun disconnected(sessionId: String?) {
        if (this.sessionId != sessionId) return
        this.sessionId = null
        transportId = null
        deviceId = null
    }

    fun destroy() {
        destroyed = true
        disconnected(sessionId)
    }

    fun nextReport(deviceId: String): SDKClientContext? {
        val session = sessionId ?: return null
        if (destroyed || this.deviceId != deviceId || sequence >= 9_007_199_254_740_991L) return null
        sequence++
        return SDKClientContext(1, session, sequence, "android", SdkIdentity.PACKAGE, SdkIdentity.VERSION)
    }
}
