package dev.bota.sdk.internal.jni

/** Shared Rust speech policy only. The media owner must silence and cancel IO on
 * any thrown error. Audio and RTC objects never cross this metadata boundary. */
internal class NativeSpeechPolicy(
    configurationJson: ByteArray,
    grantJson: ByteArray,
    nowMs: Long,
) : AutoCloseable {
    private var handle: Long = SpeechBindings.create(configurationJson, grantJson, nowMs).also {
        check(it != 0L) { "native speech allocation failed" }
    }

    @Synchronized
    fun step(commandJson: ByteArray, nowMs: Long): ByteArray {
        check(handle != 0L) { "speech policy is closed" }
        return try {
            SpeechBindings.step(handle, commandJson, nowMs)
        } catch (error: Throwable) {
            close()
            throw error
        }
    }

    @Synchronized
    override fun close() {
        val previous = handle
        handle = 0L
        if (previous != 0L) SpeechBindings.close(previous)
    }
}

private object SpeechBindings {
    init {
        System.loadLibrary("bota_device_sdk_ffi")
        System.loadLibrary("bota_android_jni")
    }

    // Byte arrays carry standard UTF-8 (JNI modified UTF-8 would corrupt emoji).
    external fun create(configuration: ByteArray, grant: ByteArray, nowMs: Long): Long
    external fun step(handle: Long, command: ByteArray, nowMs: Long): ByteArray
    external fun close(handle: Long)
}
