package dev.bota.sdk.flutter

import io.flutter.embedding.engine.plugins.FlutterPlugin
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

public class BotaFlutterSdkPlugin : FlutterPlugin {
    private var adapter: BotaAndroidAdapter? = null

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
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        BotaHostApi.setUp(binding.binaryMessenger, null)
        val detached = adapter ?: return
        adapter = null
        CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate).launch {
            detached.detach()
        }
    }
}
