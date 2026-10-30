package dev.bota.sdk.reactnative.localwifi

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

public class BotaLocalWifiPackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == BotaLocalWifiTransportModule.NAME) BotaLocalWifiTransportModule(reactContext) else null

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
        mapOf(BotaLocalWifiTransportModule.NAME to ReactModuleInfo(
            name = BotaLocalWifiTransportModule.NAME,
            className = BotaLocalWifiTransportModule::class.java.name,
            canOverrideExistingModule = false, needsEagerInit = false,
            isCxxModule = false, isTurboModule = true,
        ))
    }
}
