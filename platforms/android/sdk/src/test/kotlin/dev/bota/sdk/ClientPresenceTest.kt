package dev.bota.sdk

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ClientPresenceTest {
    @Test
    fun canonicalLifecycle() {
        val root = generateSequence(File(checkNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .first { File(it, "protocol/client-presence/v1.json").isFile }
        val fixture = JSONObject(File(root, "protocol/client-presence/v1.json").readText())
        val sessions = fixture.getJSONArray("sessions")
        val presence = ConnectionClientPresence()
        val tokens = mutableMapOf<String, String>()
        var nextSession = 0
        val steps = fixture.getJSONArray("steps")
        for (index in 0 until steps.length()) {
            val step = steps.getJSONObject(index)
            when (step.getString("action")) {
                "verified_connect" -> {
                    val id = sessions.getString(nextSession.coerceAtMost(sessions.length() - 1))
                    tokens[step.getString("connection")] = id
                    presence.connected(step.getString("device_id"), id, id)
                    nextSession++
                }
                "disconnect" -> presence.disconnected(tokens.getValue(step.getString("connection")))
                "destroy" -> presence.destroy()
                "report" -> {
                    val report = presence.nextReport(step.getString("device_id"))
                    if (step.isNull("expected")) assertNull(report) else {
                        val expected = step.getJSONObject("expected")
                        assertEquals(sessions.getString(expected.getInt("session")), report?.sessionId)
                        assertEquals(expected.getLong("sequence"), report?.sequence)
                        assertEquals(SdkIdentity.PACKAGE, report?.sdkPackage)
                        assertEquals(SdkIdentity.VERSION, report?.sdkVersion)
                    }
                }
                else -> error("unknown fixture action")
            }
        }
    }
}
