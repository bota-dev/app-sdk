package dev.bota.sdk.reactnative.localwifi

import dev.bota.sdk.reactnative.security.BotaBleSecurityModule

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

public class BotaLocalWifiPackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        when (name) {
            BotaBleSessionModule.NAME -> BotaBleSessionModule(reactContext)
            BotaLocalWifiTransportModule.NAME -> BotaLocalWifiTransportModule(reactContext)
            BotaBleSecurityModule.NAME -> BotaBleSecurityModule(reactContext)
            else -> null
        }

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
        mapOf(BotaBleSessionModule.NAME to ReactModuleInfo(
            name = BotaBleSessionModule.NAME,
            className = BotaBleSessionModule::class.java.name,
            canOverrideExistingModule = false, needsEagerInit = false,
            isCxxModule = false, isTurboModule = false,
        ), BotaBleSecurityModule.NAME to ReactModuleInfo(
            name = BotaBleSecurityModule.NAME,
            className = BotaBleSecurityModule::class.java.name,
            canOverrideExistingModule = false, needsEagerInit = false,
            isCxxModule = false, isTurboModule = true,
        ), BotaLocalWifiTransportModule.NAME to ReactModuleInfo(
            name = BotaLocalWifiTransportModule.NAME,
            className = BotaLocalWifiTransportModule::class.java.name,
            canOverrideExistingModule = false, needsEagerInit = false,
            isCxxModule = false, isTurboModule = true,
        ))
    }
}
