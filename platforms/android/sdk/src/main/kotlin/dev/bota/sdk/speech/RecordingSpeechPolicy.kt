package dev.bota.sdk.speech

import dev.bota.sdk.internal.jni.SpeechBindings

/** Direct transport metadata policy. Native IO owns capture, sockets and PCM. */
public object RecordingSpeechPolicy {
    public fun evaluate(command: ByteArray): ByteArray = SpeechBindings.recording(command)
}
