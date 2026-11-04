package dev.bota.speech.companion

import android.Manifest
import android.app.AlertDialog
import android.app.Application
import android.content.pm.PackageManager
import android.text.InputType
import android.view.View
import android.widget.*
import dev.bota.sdk.flutter.BotaFlutterSdkPlugin
import dev.bota.sdk.speech.livekit.LiveKitSpeechMedia
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.util.UUID
import kotlinx.coroutines.*

class FlutterCompanionApplication : Application() {
    internal lateinit var owner: FlutterLabOwner
    override fun onCreate() {
        super.onCreate()
        owner = FlutterLabOwner({ LiveKitSpeechMedia.create(this, it) })
    }
}

class FlutterCompanionActivity : FlutterActivity() {
    private val engineId = UUID.randomUUID().toString()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val owner get() = (application as FlutterCompanionApplication).owner
    private var channel: MethodChannel? = null
    private var dialog: AlertDialog? = null
    private var codeField: EditText? = null
    private var preparing: MethodChannel.Result? = null
    private var permission: Pair<UUID, MethodChannel.Result>? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        owner.bindEngine(engineId)
        checkNotNull(flutterEngine.plugins.get(BotaFlutterSdkPlugin::class.java) as? BotaFlutterSdkPlugin)
            .setSpeechFactory { id, observer -> owner.create(engineId, id, observer) }
        channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "dev.bota.speech.companion/host").apply {
            setMethodCallHandler { call, reply ->
                when (call.method) {
                    "prepare" -> prepare(reply)
                    "microphonePermission" -> microphone(reply)
                    "leave" -> {
                        cancelPrompts()
                        val retired = owner.leave(engineId)
                        scope.launch {
                            try { retired.await(); reply.success(null) }
                            catch (_: Exception) { reply.error("cleanupFailed", "Audio cleanup failed", null) }
                        }
                    }
                    else -> reply.notImplemented()
                }
            }
        }
    }
    private fun prepare(reply: MethodChannel.Result) {
        if (preparing != null || owner.isCurrent(engineId)) { reply.error("busy", "A session is already active", null); return }
        preparing = reply
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 16, 48, 16) }
        val origin = EditText(this).apply { hint = "Session host"; setText("http://127.0.0.1:4173"); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI }
        val role = Spinner(this).apply { adapter = ArrayAdapter(this@FlutterCompanionActivity, android.R.layout.simple_spinner_dropdown_item, listOf("Speaker A", "Speaker B")) }
        val code = EditText(this).apply {
            hint = "Access code"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            isSaveEnabled = false; importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }
        codeField = code
        listOf(origin, role, code).forEach(form::addView)
        dialog = AlertDialog.Builder(this).setTitle("Join a conversation").setView(form)
            .setNegativeButton("Cancel") { _, _ -> cancelPrompts() }
            .setOnCancelListener { cancelPrompts() }
            .setPositiveButton("Join") { _, _ ->
                val selectedOrigin = origin.text.toString(); val selectedRole = if (role.selectedItemPosition == 0) "a" else "b"
                val selectedCode = code.text.toString(); code.text.clear(); codeField = null; dialog = null
                scope.launch {
                    try {
                        val display = owner.prepare(engineId, selectedOrigin, selectedRole, selectedCode)
                        if (preparing === reply) { preparing = null; reply.success(display) }
                    } catch (_: Exception) {
                        if (preparing === reply) { preparing = null; reply.error("unavailable", "Could not join the session", null) }
                    }
                }
            }.show()
    }
    private fun microphone(reply: MethodChannel.Result) {
        val captured = owner.permissionOwner(engineId)
        if (captured == null || permission != null) { reply.success(false); return }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) { reply.success(true); return }
        permission = captured to reply
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 10)
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 10) {
            val captured = permission; permission = null
            captured?.second?.success(owner.acceptsPermission(engineId, captured.first) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
        }
    }
    private fun cancelPrompts() {
        codeField?.text?.clear(); codeField = null; dialog?.dismiss(); dialog = null
        val request = preparing; preparing = null
        request?.error("closed", "The session was closed", null)
        val prompt = permission; permission = null; prompt?.second?.success(false)
    }
    override fun onStop() { cancelPrompts(); owner.leave(engineId); super.onStop() }
    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        cancelPrompts(); owner.leave(engineId); channel?.setMethodCallHandler(null); channel = null
        super.cleanUpFlutterEngine(flutterEngine)
    }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
}
