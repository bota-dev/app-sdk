package dev.bota.speech.companion

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.text.InputType
import android.view.View
import android.widget.*
import dev.bota.sdk.flutter.BotaFlutterSdkPlugin
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.util.UUID
import kotlinx.coroutines.*

/** Flutter receives only an activity ID and final display text. Admission code,
 * capture permissions, grants, crypto and audio stay in this native owner. */
internal class RecordingFlutterHost(private val activity: Activity, plugin: BotaFlutterSdkPlugin, messenger: BinaryMessenger) {
    private data class Selection(val id: String, val origin: String, val code: String, val target: String, val retention: String)
    private val tasks = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val channel = MethodChannel(messenger, "dev.bota.recording.companion/host")
    @Volatile private var foreground = true
    private var revision = 0
    private var selected: Selection? = null
    private var active: RecordingLabOwner? = null
    private var creating: Deferred<RecordingLabOwner>? = null
    private var closing: Deferred<Unit>? = null
    private var reply: MethodChannel.Result? = null
    private var dialog: AlertDialog? = null
    private var code: EditText? = null
    init {
        plugin.setRecordingSpeechFactory { id, caption, status ->
            val value = selected ?: throw LabFailure(); check(foreground && value.id == id); selected = null
            val owned = revision
            val task = tasks.async { RecordingLabOwner.start(activity, value.origin, value.code, id, value.target, value.retention,
                { headphoneRoute() }, caption, status, captureAllowed = { foreground && owned == revision }) }
            creating = task
            val connection = task.await(); active = connection
            if (!foreground || owned != revision) { connection.close(); throw LabFailure() }
            connection
        }
        channel.setMethodCallHandler { call, result -> when (call.method) {
            "prepare" -> prepare(result)
            "original" -> { val value = active?.originalView() ?: OriginalView(); result.success(mapOf("status" to value.status, "passages" to value.passages)) }
            "leave" -> tasks.launch { try { leave().await(); result.success(null) } catch (_: Exception) { result.error("cleanupFailed", "Recording cleanup failed", null) } }
            else -> result.notImplemented()
        } }
    }
    @Suppress("DEPRECATION") private fun headphoneRoute(): Boolean {
        val manager = activity.getSystemService(AudioManager::class.java) ?: return false
        return if (Build.VERSION.SDK_INT >= 31) manager.communicationDevice?.type in listOf(AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET)
        else manager.isWiredHeadsetOn || manager.isBluetoothScoOn
    }
    private fun prepare(result: MethodChannel.Result) {
        if (!foreground || reply != null || selected != null || active != null || creating?.isCompleted == false || closing?.isCancelled == true || closing?.isCompleted == false) {
            result.error("busy", "Recording is busy", null); return
        }
        reply = result
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 11)
        else prompt()
    }
    fun permissionResult(request: Int) {
        if (request != 11 || reply == null) return
        if (foreground && activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) prompt()
        else { reply?.error("permissionDenied", "Microphone permission denied", null); reply = null }
    }
    private fun prompt() {
        val form = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(40, 16, 40, 16) }
        val origin = EditText(activity).apply { setText("http://127.0.0.1:4173"); hint = "Local host" }
        val credential = EditText(activity).apply { hint = "Operator access code"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            isSaveEnabled = false; importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO }
        code = credential
        val languages = listOf("zh","en","ja","ko","es","fr","de")
        val target = Spinner(activity).apply { adapter = ArrayAdapter(activity, android.R.layout.simple_spinner_dropdown_item, languages) }
        val modes = listOf("original_audio_and_text","text_only","live_only")
        val retention = Spinner(activity).apply { adapter = ArrayAdapter(activity, android.R.layout.simple_spinner_dropdown_item, listOf("Audio and text","Text only","Live only")) }
        listOf(origin, credential, target, retention).forEach(form::addView)
        dialog = AlertDialog.Builder(activity).setTitle("Start recording translation").setView(form).setNegativeButton("Cancel") { _, _ -> leave() }
            .setOnCancelListener { leave() }.setPositiveButton("Continue") { _, _ ->
                val id = UUID.randomUUID().toString()
                selected = Selection(id, origin.text.toString(), credential.text.toString(), languages[target.selectedItemPosition], modes[retention.selectedItemPosition])
                credential.text.clear(); code = null; dialog = null
                reply?.success(mapOf("activityId" to id, "target" to languages[target.selectedItemPosition])); reply = null
            }.show()
    }
    fun resume() { foreground = true }
    fun stop() { foreground = false; leave() }
    fun leave(): Deferred<Unit> {
        revision++; selected = null; code?.text?.clear(); code = null; dialog?.dismiss(); dialog = null
        reply?.error("closed", "Recording closed", null); reply = null
        closing?.let { if (!it.isCompleted || it.isCancelled) return it }
        val pending = creating; val owner = active
        return tasks.async(NonCancellable) {
            val acquired = owner ?: runCatching { pending?.await() }.getOrElse { if (it is RecordingCleanupFailure) throw it; null }
            acquired?.close(); active = null; creating = null
        }.also { closing = it }
    }
    fun detach() { foreground = false; channel.setMethodCallHandler(null); tasks.launch { try { leave().await() } finally { tasks.cancel() } } }
}
