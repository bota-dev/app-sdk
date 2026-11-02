package dev.bota.sdk.speech.livekit

import dev.bota.sdk.speech.SpeechGrant

/** Internal IO seams for deterministic native-lifecycle tests; authorization stays in Rust. */
internal interface RtcInput {
    var enabled: Boolean
    val sid: String?
    fun dispose()
}
internal interface RtcListener {
    fun text(sender: String, json: String)
    fun frame(sender: String, sid: String, frame: PcmFrame)
    fun removed(sid: String)
    fun disconnected()
    fun failed()
}
internal interface RtcRoom {
    var listener: RtcListener?
    val identity: String?
    val name: String?
    suspend fun connect(grant: SpeechGrant)
    suspend fun createInput(): RtcInput
    suspend fun publish(input: RtcInput)
    fun unpublish(input: RtcInput)
    fun subscribe(sids: Set<String>)
    fun muteInput()
    fun disconnect()
    suspend fun release()
}
internal data class PcmFrame(val samples: ByteArray, val sampleRate: Int, val channels: Int)
internal interface PcmOutput {
    fun silence()
    fun select(sids: Set<String>)
    fun frame(sid: String, frame: PcmFrame)
    suspend fun clear()
    suspend fun drain(sid: String)
    suspend fun close()
}
