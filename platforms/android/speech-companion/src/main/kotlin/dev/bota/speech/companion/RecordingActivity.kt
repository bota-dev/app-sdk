package dev.bota.speech.companion

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.*
import java.util.UUID
import kotlinx.coroutines.*
import org.json.JSONObject

/** Maintained native consumer of the direct microphone/archive/translation path. */
class RecordingActivity : Activity() {
    private val tasks = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var owner: RecordingLabOwner? = null
    private var starting: Deferred<RecordingLabOwner>? = null
    private var closing: Deferred<Unit>? = null
    private var revision = 0
    @Volatile private var foreground = false
    private var busy = false
    private var cleanupFailed = false
    private lateinit var origin: EditText; private lateinit var code: EditText
    private lateinit var target: Spinner; private lateinit var retention: Spinner
    private lateinit var notice: TextView; private lateinit var captions: TextView; private lateinit var finalText: TextView
    private val lines = linkedMapOf<String, String>()
    private val languages = listOf("zh","en","ja","ko","es","fr","de")
    private val modes = listOf("original_audio_and_text","text_only","live_only")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(36, 40, 36, 40) }
        fun text(value: String, size: Float = 16f) = TextView(this).apply { text = value; textSize = size; form.addView(this) }
        fun button(value: String, action: () -> Unit) { form.addView(Button(this).apply { text = value; setOnClickListener { action() } }) }
        text("Recording translation", 26f); text("One microphone. One target language. Use headphones for translation audio.")
        origin = EditText(this).apply { hint = "Local host"; setText(R.string.default_host) }; form.addView(origin)
        code = EditText(this).apply { hint = "Operator access code"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            isSaveEnabled = false; importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO }; form.addView(code)
        target = Spinner(this).apply { adapter = ArrayAdapter(this@RecordingActivity, android.R.layout.simple_spinner_dropdown_item, languages) }; form.addView(target)
        retention = Spinner(this).apply { adapter = ArrayAdapter(this@RecordingActivity, android.R.layout.simple_spinner_dropdown_item, listOf("Audio and text","Text only","Live only")) }; form.addView(retention)
        button("Start microphone") {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) start()
            else requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 12)
        }
        button("Apply language") { command { owner?.changeTarget(languages[target.selectedItemPosition], UUID.randomUUID().toString()); notice.setText(R.string.recording_language_ack) } }
        button("Confirm headphones") { command { notice.text = if (owner?.qualifyHeadphones() == true) "Headphone playback enabled." else "Audio paused. Captions and original capture continue." } }
        button("Stop capture") { command { owner?.finish(); notice.setText(R.string.recording_stopped) } }
        button("Close") { retire() }
        notice = text("Ready"); text("Live captions (provisional)", 20f); captions = text(""); text("Final original and translation", 20f); finalText = text("")
        setContentView(ScrollView(this).apply { addView(form) })
        tasks.launch { while (isActive) { delay(2000); owner?.originalView()?.let { finalText.text = getString(R.string.original_preview, it.status, it.passages.joinToString("\n\n")) } } }
    }
    private fun command(work: suspend () -> Unit) { if (busy || !foreground || owner == null) return; busy = true
        tasks.launch { try { work() } catch (_: Exception) { notice.setText(R.string.recording_unavailable) } finally { busy = false } } }
    @Suppress("DEPRECATION") private fun headphones(): Boolean {
        val manager = getSystemService(AudioManager::class.java) ?: return false
        return if (Build.VERSION.SDK_INT >= 31) manager.communicationDevice?.type in listOf(AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET) else manager.isWiredHeadsetOn || manager.isBluetoothScoOn
    }
    private fun start() {
        if (!foreground || owner != null || starting?.isCompleted == false || busy || cleanupFailed) return
        val previousClose = closing
        val owned = ++revision; val selectedOrigin = origin.text.toString(); val access = code.text.toString(); code.text.clear()
        val language = languages[target.selectedItemPosition]; val mode = modes[retention.selectedItemPosition]
        notice.setText(R.string.recording_connecting); lines.clear(); captions.text = ""; finalText.text = ""
        val task = tasks.async {
            previousClose?.await()
            RecordingLabOwner.start(this@RecordingActivity, selectedOrigin, access, UUID.randomUUID().toString(), language, mode, { headphones() },
                { bytes ->
                    try {
                        val event = JSONObject(bytes.toString(Charsets.UTF_8)); val caption = event.getJSONObject("caption")
                        val key = caption.getString("unitId") + ":" + caption.optString("targetLanguage", "source")
                        val value = "[${caption.optString("targetLanguage", caption.getString("sourceLanguage"))}; revision ${caption.getInt("revision")}] ${caption.getString("text")}"
                        tasks.launch { if (owned == revision) { lines[key] = value; if (lines.size > 100) lines.remove(lines.keys.first()); captions.text = lines.values.joinToString("\n") } }
                    } finally { bytes.fill(0) }
                }, { status -> tasks.launch { if (owned == revision) notice.text = status } }, captureAllowed = { foreground && revision == owned })
        }; starting = task
        tasks.launch {
            try { val acquired = task.await(); if (foreground && revision == owned) { owner = acquired } else acquired.close() }
            catch (_: Exception) { if (revision == owned) notice.setText(R.string.recording_start_failed) }
        }
    }
    private fun retire() {
        revision++; code.text.clear(); val pending = starting; val captured = owner; owner = null
        if (closing?.isCompleted == false || cleanupFailed) return
        closing = tasks.async(NonCancellable) {
            try { (captured ?: runCatching { pending?.await() }.getOrElse { if (it is RecordingCleanupFailure) throw it; null })?.close(); notice.setText(R.string.recording_closed) }
            catch (_: Exception) { cleanupFailed = true; notice.setText(R.string.recording_cleanup_failed); throw LabFailure() }
        }
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 12 && foreground && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) start()
    }
    override fun onResume() { super.onResume(); foreground = true }
    override fun onStop() { foreground = false; retire(); super.onStop() }
    override fun onDestroy() { tasks.cancel(); super.onDestroy() }
}
