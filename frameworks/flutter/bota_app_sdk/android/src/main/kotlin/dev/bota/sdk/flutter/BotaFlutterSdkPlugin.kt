package dev.bota.sdk.flutter

import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

public class BotaFlutterSdkPlugin : FlutterPlugin {
    private var adapter: BotaAndroidAdapter? = null
    private var speech: BotaAndroidSpeechAdapter? = null
    private var recordingSpeech: BotaAndroidRecordingSpeechAdapter? = null
    public var recordingSpeechShutdown: Deferred<Unit>? = null
        private set
    public var speechShutdown: Deferred<Unit>? = null
        private set

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        val applicationContext = binding.applicationContext.applicationContext
            ?: error("Bota Flutter SDK requires an application context")
        BotaAndroidNativeClient.bind(applicationContext)
        val attached = BotaAndroidAdapter(
            engineId = UUID.randomUUID().toString(),
            client = BotaAndroidNativeClient,
            leaseCoordinator = NativeLeaseCoordinator.shared,
            flutterApi = PigeonBotaFlutterBridge(BotaFlutterApi(binding.binaryMessenger)),
        )
        adapter = attached
        BotaHostApi.setUp(binding.binaryMessenger, attached)
        val speechApi = BotaSpeechFlutterApi(binding.binaryMessenger)
        val attachedSpeech = BotaAndroidSpeechAdapter(
            emit = { deliverSpeechEvent(speechApi, it) },
            terminal = { event -> speechApi.onEvent(event) {} },
        )
        speech = attachedSpeech
        BotaSpeechHostApi.setUp(binding.binaryMessenger, attachedSpeech)
        val recordingApi = BotaRecordingSpeechFlutterApi(binding.binaryMessenger)
        val attachedRecording = BotaAndroidRecordingSpeechAdapter(
            emit = { deliverRecordingSpeechEvent(recordingApi, it) },
            terminal = { event -> recordingApi.onEvent(event) {} },
        )
        recordingSpeech = attachedRecording
        BotaRecordingSpeechHostApi.setUp(binding.binaryMessenger, attachedRecording)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        BotaHostApi.setUp(binding.binaryMessenger, null)
        BotaSpeechHostApi.setUp(binding.binaryMessenger, null)
        BotaRecordingSpeechHostApi.setUp(binding.binaryMessenger, null)
        recordingSpeechShutdown = recordingSpeech?.retire()
        recordingSpeech = null
        speechShutdown = speech?.retire()
        speech = null
        val detached = adapter ?: return
        adapter = null
        CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate).launch {
            detached.detach()
        }
    }

    /** Install on the main thread before the first speech session. The native App
     * prepares initial grants and retains its authenticated HTTP/media integration. */
    public fun setSpeechFactory(factory: BotaFlutterSpeechFactory) {
        check(Looper.myLooper() == Looper.getMainLooper()) { "Speech integration requires the main thread" }
        speechShutdown?.let {
            check(it.isCompleted && !it.isCancelled) { "Previous speech cleanup has not succeeded" }
        }
        val owner = checkNotNull(speech) { "Flutter engine is detached" }
        owner.setFactory { id, observer -> NativeFlutterSpeechSession(factory.create(id, observer)) }
    }
    /** Install a native composition with independent original capture. */
    public fun setSpeechConnectionFactory(factory: BotaFlutterSpeechConnectionFactory) {
        check(Looper.myLooper() == Looper.getMainLooper()) { "Speech integration requires the main thread" }
        speechShutdown?.let { check(it.isCompleted && !it.isCancelled) { "Previous speech cleanup has not succeeded" } }
        checkNotNull(speech) { "Flutter engine is detached" }.setFactory { id, observer -> factory.create(id, observer) }
    }
    /** Install direct activity admission, with credentials and input remaining native. */
    public fun setRecordingSpeechFactory(factory: BotaFlutterRecordingSpeechFactory) {
        check(Looper.myLooper() == Looper.getMainLooper()) { "Speech integration requires the main thread" }
        recordingSpeechShutdown?.let { check(it.isCompleted && !it.isCancelled) { "Previous recording speech cleanup has not succeeded" } }
        checkNotNull(recordingSpeech) { "Flutter engine is detached" }.setFactory(factory)
    }
}
