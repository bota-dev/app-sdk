package dev.bota.speech.companion

import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import java.util.UUID
import kotlinx.coroutines.*
import org.json.JSONObject

/** App-native admission and control. Only captions and display metadata reach JS. */
class RecordingLabHost(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
    private val tasks = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private data class Selection(val id: String, val origin: String, val code: String, val target: String, val retention: String)
    private var selection: Selection? = null
    private var active: RecordingLabOwner? = null
    private var retired = false
    @Volatile private var headphonesConfirmed = false
    private val bridge = RecordingLabBridge({ id, caption, status ->
        val value = selection ?: throw LabFailure(); check(id == value.id && foreground()); selection = null
        RecordingLabOwner.start(context, value.origin, value.code, id, value.target, value.retention,
            { headphonesConfirmed && headphoneRoute() }, caption, { code -> if (code == "output_skipped") headphonesConfirmed = false; status(code) }, captureAllowed = { foreground() }).also {
            active = it
            if (!foreground()) { it.close(); throw LabFailure() }
        }
    }, tasks)
    init { context.addLifecycleEventListener(this) }
    override fun getName() = "RecordingLabHost"
    private fun foreground() = !retired && context.lifecycleState == LifecycleState.RESUMED
    @Suppress("DEPRECATION")
    private fun headphoneRoute(): Boolean {
        val manager = context.getSystemService(AudioManager::class.java) ?: return false
        return if (Build.VERSION.SDK_INT >= 31) manager.communicationDevice?.type in listOf(AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET)
        else manager.isWiredHeadsetOn || manager.isBluetoothScoOn
    }
    private fun run(reply: Promise, action: suspend () -> Any?) { tasks.launch {
        try { check(foreground()); reply.resolve(action()) } catch (_: Exception) { reply.reject("unavailable", "Recording operation unavailable") }
    } }
    @ReactMethod fun prepare(origin: String, code: String, target: String, retention: String, reply: Promise) = run(reply) {
        check(selection == null && active == null)
        UUID.randomUUID().toString().also { selection = Selection(it, origin, code, target, retention) }
    }
    @ReactMethod fun start(id: String, activityId: String, reply: Promise) = run(reply) { bridge.start(id, activityId); null }
    @ReactMethod fun changeTarget(id: String, language: String, requestId: String, reply: Promise) = run(reply) { bridge.call(id) { it.changeTarget(language, requestId) }; null }
    @ReactMethod fun qualifyHeadphones(id: String, reply: Promise) = run(reply) { headphonesConfirmed = true; bridge.call(id) { it.qualifyHeadphones() } }
    @ReactMethod fun finish(id: String, reply: Promise) = run(reply) { bridge.call(id) { it.finish() }; null }
    @ReactMethod fun events(id: String, reply: Promise) = run(reply) { bridge.events(id) }
    @ReactMethod fun original(reply: Promise) = run(reply) {
        val view = active?.originalView() ?: OriginalView()
        JSONObject().put("status", view.status).put("passages", org.json.JSONArray(view.passages)).toString()
    }
    @ReactMethod fun close(id: String, reply: Promise) { tasks.launch {
        try { bridge.close(id); active = null; selection = null; headphonesConfirmed = false; reply.resolve(null) }
        catch (_: Exception) { reply.reject("cleanup_failed", "Recording cleanup failed") }
    } }
    @ReactMethod fun leave(reply: Promise) { selection = null; headphonesConfirmed = false; tasks.launch {
        try { bridge.close(); active = null; reply.resolve(null) } catch (_: Exception) { reply.reject("cleanup_failed", "Recording cleanup failed") }
    } }
    private fun retire() { selection = null; headphonesConfirmed = false; tasks.launch { runCatching { bridge.close() }; active = null } }
    override fun onHostPause() { retire() }
    override fun onHostResume() {}
    override fun onHostDestroy() { retire() }
    override fun invalidate() { retired = true; selection = null; context.removeLifecycleEventListener(this)
        tasks.launch { try { bridge.close() } finally { tasks.cancel() } }; super.invalidate() }
}
