package dev.bota.sdk.reactnative

import dev.bota.sdk.reactnative.upload.BotaUploadV2BackendModule
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

public class BotaDeviceSDKPackage : BaseReactPackage() {
    override fun getModule(
        name: String,
        reactContext: ReactApplicationContext,
    ): NativeModule? =
        if (name == BotaDeviceSDKModule.NAME) {
            BotaDeviceSDKModule(reactContext)
        } else if (name == BotaUploadV2BackendModule.NAME) {
            BotaUploadV2BackendModule(reactContext)
        } else {
            null
        }

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
        ReactModuleInfoProvider {
            mapOf(
                BotaUploadV2BackendModule.NAME to ReactModuleInfo(
                    name = BotaUploadV2BackendModule.NAME,
                    className = BotaUploadV2BackendModule::class.java.name,
                    canOverrideExistingModule = false, needsEagerInit = false,
                    isCxxModule = false, isTurboModule = true,
                ),
                BotaDeviceSDKModule.NAME to ReactModuleInfo(
                    name = BotaDeviceSDKModule.NAME,
                    className = BotaDeviceSDKModule::class.java.name,
                    canOverrideExistingModule = false,
                    needsEagerInit = false,
                    isCxxModule = false,
                    isTurboModule = true,
                ),
            )
        }
}
