package dev.bota.sdk.speech

import dev.bota.sdk.internal.jni.SpeechBindings

/** Shared archive metadata policy. Native IO authenticates the encrypted journal
 * before restoring it. PCM, keys and ciphertext never cross this boundary. */
public object SpeechCapturePolicy {
    public fun evaluate(command: ByteArray): ByteArray = SpeechBindings.capture(command)
}
