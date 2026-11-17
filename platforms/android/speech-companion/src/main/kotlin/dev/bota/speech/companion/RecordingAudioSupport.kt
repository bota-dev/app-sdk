package dev.bota.speech.companion

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper

internal data class OriginalView(val enabled: Boolean = false, val capturing: Boolean = false, val finished: Boolean = false,
    val status: String = "", val passages: List<String> = emptyList()) {
    override fun toString() = "OriginalView(content redacted)"
}

/** The companion reserves communication audio explicitly; reusable SDK capture
 * never changes a host application's audio focus or global mode. */
internal class OriginalAudioRoute(context: Context, lost: () -> Unit) {
    private val manager = context.getSystemService(AudioManager::class.java) ?: throw LabFailure()
    private val prior = manager.mode
    private val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setOnAudioFocusChangeListener({ if (it != AudioManager.AUDIOFOCUS_GAIN) lost() }, Handler(Looper.getMainLooper())).build()
    init {
        if (prior != AudioManager.MODE_NORMAL || manager.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) throw LabFailure()
        try { manager.mode = AudioManager.MODE_IN_COMMUNICATION }
        catch (error: Exception) { manager.abandonAudioFocusRequest(request); throw error }
    }
    fun close() {
        try {
            if (manager.mode != AudioManager.MODE_IN_COMMUNICATION) throw LabFailure()
            manager.mode = prior
        } finally { manager.abandonAudioFocusRequest(request) }
    }
}
