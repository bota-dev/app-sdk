package dev.bota.speech.companion

import android.Manifest
import android.app.Activity
import android.app.Application
import android.content.pm.PackageManager
import android.os.Bundle
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.common.LifecycleState
import com.facebook.react.uimanager.ViewManager
import java.net.URI
import kotlinx.coroutines.*

/** App-owned native IO. Shared speech-session decisions remain in generated JS. */
class SpeechLabHost(context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val transport = NativeLabTransport()
    private val requests = mutableMapOf<String, Job>()
    private var retired = false
    private var foreground = context.lifecycleState == LifecycleState.RESUMED
    private var revision = 0
    @Volatile private var owner: ReactNativeLabOwner? = null
    private var closing: Deferred<Unit>? = null
    private val application = context.applicationContext as Application
    private val activityLifecycle = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityStopped(activity: Activity) {
            if (activity === reactApplicationContext.currentActivity) scope.launch { foreground = false; closeOwner() }
        }
        override fun onActivityCreated(activity: Activity, state: Bundle?) {}
        override fun onActivityStarted(activity: Activity) {}
        override fun onActivityResumed(activity: Activity) {}
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {}
    }
    init { context.addLifecycleEventListener(this); application.registerActivityLifecycleCallbacks(activityLifecycle) }
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
                    val response = if (action == "join") {
                        closing?.await()
                        if (owner != null) throw LabFailure()
                        val acquired = ReactNativeLabOwner(reactApplicationContext, origin, role, code); owner = acquired
                        try { LabResponse(200, acquired.prepare()) }
                        catch (error: Exception) {
                            withContext(NonCancellable) { acquired.close() }; if (owner === acquired) owner = null; throw error
                        }
                    } else if (action == "grant") LabResponse(200, (owner ?: throw LabFailure()).renew())
                    else transport.send(LabRequest("$origin/speech-host/$action", mapOf(
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
    private fun perform(promise: Promise, action: suspend (ReactNativeLabOwner) -> Any?) {
        scope.launch {
            try { if (retired || !foreground) throw LabFailure(); promise.resolve(action(owner ?: throw LabFailure())) }
            catch (_: Exception) { promise.reject("unavailable", "Speech operation unavailable") }
        }
    }
    @ReactMethod fun createMedia(sessionId: String, promise: Promise) = perform(promise) { it.createMedia(sessionId) }
    @ReactMethod fun mediaCommand(handle: String, action: String, body: String, promise: Promise) = perform(promise) { it.command(handle, action, body) }
    @ReactMethod(isBlockingSynchronousMethod = true) fun mediaFence(handle: String, action: String): Boolean = owner?.fence(handle, action) ?: true
    @ReactMethod fun mediaEvents(handle: String, promise: Promise) = perform(promise) { it.events(handle) }
    @ReactMethod fun closeMedia(handle: String, promise: Promise) {
        scope.launch {
            try { owner?.closeMedia(handle); promise.resolve(null) }
            catch (_: Exception) { promise.reject("cleanup_failed", "Speech cleanup failed") }
        }
    }
    @ReactMethod fun startOriginal(promise: Promise) = perform(promise) { it.startOriginal(); null }
    @ReactMethod fun finishOriginal(promise: Promise) = perform(promise) { it.finishOriginal(); null }
    @ReactMethod fun originalView(promise: Promise) = perform(promise) { it.originalView() }
    private fun closeOwner(): Deferred<Unit> {
        closing?.let { if (!it.isCompleted || it.isCancelled) return it }
        val captured = owner; val pending = requests.values.toList(); retireRequests()
        return scope.async(start = CoroutineStart.LAZY) {
            try { captured?.close(); pending.joinAll() }
            finally { if (owner === captured) owner = null }
        }.also { closing = it; it.start() }
    }
    @ReactMethod fun closeSession(promise: Promise) {
        scope.launch { try { closeOwner().await(); promise.resolve(null) } catch (_: Exception) { promise.reject("cleanup_failed", "Speech cleanup failed") } }
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
    // Permission dialogs pause a still-visible Activity. Retire physical IO when
    // it stops; permission ownership is otherwise checked against the revision.
    override fun onHostPause() { scope.launch { foreground = false } }
    override fun onHostResume() { scope.launch { foreground = true } }
    override fun onHostDestroy() { scope.launch { foreground = false; closeOwner() } }
    override fun invalidate() {
        reactApplicationContext.removeLifecycleEventListener(this)
        application.unregisterActivityLifecycleCallbacks(activityLifecycle)
        scope.launch { retired = true; try { closeOwner().await() } finally { transport.close(); scope.cancel() } }
        super.invalidate()
    }
}
class SpeechLabPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(SpeechLabHost(context))
    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
