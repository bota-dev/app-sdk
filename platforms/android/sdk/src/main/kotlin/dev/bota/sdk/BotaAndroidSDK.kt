package dev.bota.sdk

/** Synchronized package metadata for Bota SDK for Android. */
public object BotaAndroidSDK {
    public val version: String
        get() = BuildConfig.BOTA_SDK_VERSION

    public const val mavenGroup: String = "dev.bota"
    public const val mavenArtifact: String = "bota-android-sdk"
}
