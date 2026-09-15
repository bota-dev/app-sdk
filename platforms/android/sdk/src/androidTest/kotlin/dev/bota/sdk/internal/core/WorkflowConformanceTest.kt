package dev.bota.sdk.internal.core

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WorkflowConformanceTest {
    @Test
    fun allCanonicalWorkflowTracesMapToAndroidCoreTypes() {
        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        val suite = assets.open("WorkflowFixtures/workflows.json").bufferedReader().use {
            JSONObject(it.readText())
        }
        val scenarios = suite.getJSONArray("scenarios").objects()

        assertEquals(1, suite.getInt("schemaVersion"))
        assertEquals(33, scenarios.size)
        assertEquals(33, scenarios.map { it.getString("name") }.toSet().size)
        assertEquals(8, scenarios.map { it.getString("workflow") }.toSet().size)

        scenarios.forEach { scenario ->
            val name = scenario.getString("name")
            assertNotNull(name, CoreCommand.fixtureNamed(scenario.getString("command")))
            CoreCapabilities.fromNames(scenario.getJSONArray("capabilities").strings())
            assertTrue(name, scenario.getJSONArray("effects").strings().all(effectVocabulary::contains))
            assertTrue(
                name,
                scenario.getJSONArray("notifications").strings().all(notificationVocabulary::contains),
            )
            assertTrue(name, scenario.getString("terminalStatus") in terminalStatuses)
        }
    }

    private companion object {
        val effectVocabulary = setOf(
            "abort", "append_new_sequence", "append_sink", "cancel_timer", "cleanup_subscription",
            "confirm_delete", "connect", "connect_next", "delete_checkpoint", "delete_result", "disconnect",
            "discover_services", "abort_v2", "acknowledge_window", "await_receipt", "confirm_with_receipt",
            "discard_sink", "download", "final_ack", "finalize_sink", "load_checkpoint", "nack",
            "prepare_material", "prepare_session", "read_blob_chunks", "read_blob_from_zero", "read_capabilities", "read_nonce",
            "read_public_key", "read_serial", "read_status", "read_version", "reconnect", "restart_transfer",
            "repair_window", "retain_recording", "save_checkpoint", "save_identity", "save_result", "select_profile",
            "skip_durable_sequence", "stage_artifacts", "start_logging", "start_scan", "start_transfer", "start_upload",
            "start_v2_transfer", "stop_logging", "stop_scan", "subscribe",
            "truncate_sink", "truncate_to_checkpoint", "unsubscribe", "verify", "write_chunks", "write_grant",
            "write_receipt", "write_reset",
        )
        val notificationVocabulary = setOf(
            "ble_fallback_ready", "cancelled", "completed", "connection_established", "device_log", "encrypted_upload_v2_staged", "failed",
            "firmware_progress", "progress", "retrying", "started",
        )
        val terminalStatuses = setOf("idle", "running", "completed", "cancelled", "failed")
    }
}

private fun JSONArray.objects(): List<JSONObject> = List(length(), ::getJSONObject)
private fun JSONArray.strings(): List<String> = List(length(), ::getString)
