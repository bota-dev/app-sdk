package dev.bota.speech.companion

import android.Manifest
import android.content.pm.PackageManager
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.uimanager.ViewManager
import kotlinx.coroutines.*

/** Permission-only capability; recording admission and audio stay in RecordingLabHost. */
class MicrophonePermission(context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var retired = false
    private var foreground = context.lifecycleState == LifecycleState.RESUMED
    private var revision = 0
    init { context.addLifecycleEventListener(this) }
    override fun getName() = "MicrophonePermission"
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
    // A permission dialog may pause a still-visible Activity.
    override fun onHostPause() { foreground = false }
    override fun onHostResume() { foreground = true }
    override fun onHostDestroy() { foreground = false; revision++ }
    override fun invalidate() {
        retired = true; revision++
        reactApplicationContext.removeLifecycleEventListener(this)
        scope.cancel(); super.invalidate()
    }
}
class RecordingLabPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(MicrophonePermission(context), RecordingLabHost(context))
    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
