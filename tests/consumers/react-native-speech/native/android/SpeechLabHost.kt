package dev.bota.speech.companion

import android.Manifest
import android.content.pm.PackageManager
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.common.LifecycleState
import com.facebook.react.uimanager.ViewManager
import java.net.URI
import kotlinx.coroutines.*

/** Internal loopback HTTP only. Media stays in the public RN LiveKit adapter. */
class SpeechLabHost(context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val transport = NativeLabTransport()
    private val requests = mutableMapOf<String, Job>()
    private var retired = false
    private var foreground = context.lifecycleState == LifecycleState.RESUMED
    private var revision = 0
    init { context.addLifecycleEventListener(this) }
    override fun getName() = "SpeechLabHost"

    @ReactMethod
    fun request(id: String, origin: String, role: String, code: String, action: String, body: String, promise: Promise) {
        scope.launch {
            val uri = runCatching { URI(origin) }.getOrNull()
            if (retired || !foreground || reactApplicationContext.currentActivity == null || requests.size >= 8 || requests.containsKey(id) ||
                !Regex("[0-9]{1,16}").matches(id) || uri == null || uri.scheme != "http" || uri.host != "127.0.0.1" ||
                uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null || uri.path != "" ||
                (uri.port != -1 && uri.port !in 1..65535) || role !in listOf("a", "b") ||
                !Regex("[A-Za-z0-9_-]{32,128}").matches(code) ||
                action !in listOf("join", "grant", "subscription", "captions", "finish") || body.toByteArray().size > 8192) {
                promise.reject("unavailable", "Speech host unavailable"); return@launch
            }
            val ownRevision = revision
            val job = scope.launch(start = CoroutineStart.LAZY) {
                try {
                    val response = transport.send(LabRequest("$origin/speech-host/$action", mapOf(
                        "Content-Type" to "application/json", "Origin" to origin,
                        "X-Speech-Role" to role, "X-Speech-Code" to code), body))
                    ensureActive()
                    if (retired || revision != ownRevision) throw LabFailure()
                    promise.resolve(Arguments.createMap().apply { putInt("status", response.status); putString("body", response.body) })
                } catch (_: Exception) { promise.reject("unavailable", "Speech host unavailable") }
                finally { requests.remove(id) }
            }
            requests[id] = job; job.start()
        }
    }
    @ReactMethod
    fun cancel(id: String, promise: Promise) {
        scope.launch { requests[id]?.cancelAndJoin(); promise.resolve(null) }
    }
    @ReactMethod
    fun microphonePermission(promise: Promise) {
        scope.launch {
            if (retired || !foreground || reactApplicationContext.currentActivity == null) { promise.resolve(false); return@launch }
            if (reactApplicationContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                promise.resolve(true); return@launch
            }
            val owner = reactApplicationContext.currentActivity as? PermissionAwareActivity
            if (owner == null) { promise.resolve(false); return@launch }
            val ownRevision = revision
            owner.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 4173) { request, _, results ->
                if (request != 4173) false else {
                    promise.resolve(!retired && revision == ownRevision && results.firstOrNull() == PackageManager.PERMISSION_GRANTED)
                    true
                }
            }
        }
    }
    private fun retireRequests() { revision++; requests.values.toList().forEach { it.cancel() } }
    override fun onHostPause() { scope.launch { foreground = false; retireRequests() } }
    override fun onHostResume() { scope.launch { foreground = true } }
    override fun onHostDestroy() { scope.launch { foreground = false; retireRequests() } }
    override fun invalidate() {
        reactApplicationContext.removeLifecycleEventListener(this)
        scope.launch { retired = true; retireRequests(); transport.close(); scope.cancel() }
        super.invalidate()
    }
}
class SpeechLabPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(SpeechLabHost(context))
    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
