package dev.bota.sdk.speech.livekit

import android.content.Context
import android.media.AudioFormat
import dev.bota.sdk.speech.SpeechGrant
import io.livekit.android.AudioOptions
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.audio.AudioBufferCallback
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.network.ReconnectContext
import io.livekit.android.room.network.ReconnectPolicy
import io.livekit.android.room.participant.AudioTrackPublishOptions
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.LocalAudioTrackOptions
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.Track
import io.livekit.android.util.LoggingLevel
import java.util.concurrent.ConcurrentHashMap
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicInteger
import kotlin.time.Duration
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import livekit.org.webrtc.AudioTrackSink
import livekit.org.webrtc.audio.JavaAudioDeviceModule

/** Uses public LiveKit 2.29.0 APIs only. Built-in playout is muted for the complete room lifetime. */
internal class VendorRtcRoom(context: Context, private val scope: CoroutineScope,
    private val externalInput: ExternalPcmInput? = null,
) : RtcRoom {
    @Volatile override var listener: RtcListener? = null
    @Volatile private var allowed = emptySet<String>()
    @Volatile private var processor = ""
    @Volatile private var retired = false
    private val readers = AtomicInteger()
    private val jobs = ConcurrentHashMap.newKeySet<Job>()
    private data class Sink(val track: RemoteAudioTrack, val sink: AudioTrackSink)
    private val sinks = ConcurrentHashMap<String, Sink>()
    private val room = run {
        LiveKit.loggingLevel = LoggingLevel.OFF
        LiveKit.enableWebRTCLogging = false
        LiveKit.create(context, RoomOptions(reconnectPolicy = object : ReconnectPolicy {
            override fun getNextRetryDelay(context: ReconnectContext): Duration? = null
        }), LiveKitOverrides(audioOptions = if (externalInput == null) AudioOptions(disableAudioPrewarming = true) else AudioOptions(
            audioHandler = NoAudioHandler(),
            disableAudioPrewarming = true,
            disableCommunicationModeWorkaround = true,
            javaAudioDeviceModuleCustomizer = { builder ->
                builder.setInputSampleRate(48000).setUseStereoInput(false)
                    .setAudioFormat(AudioFormat.ENCODING_PCM_16BIT)
                    .setUseHardwareAcousticEchoCanceler(false).setUseHardwareNoiseSuppressor(false)
            },
        ))).also {
            // Disable physical AudioRecord before connection or track acquisition. Do not fall back.
            if (externalInput != null) (it.lkObjects.audioDeviceModule as JavaAudioDeviceModule).setAudioRecordEnabled(false)
            it.setSpeakerMute(true)
            it.setMicrophoneMute(true)
        }
    }
    override val identity: String? get() = room.localParticipant.identity?.value
    override val name: String? get() = room.name

    private fun observe(block: suspend () -> Unit) {
        val job = synchronized(jobs) {
            if (retired) return
            scope.launch(start = CoroutineStart.LAZY) {
                try { block() }
                catch (_: TimeoutCancellationException) { listener?.failed() }
                catch (_: CancellationException) { /* Room retirement cancels observers. */ }
                catch (_: Exception) { listener?.failed() }
            }.also { jobs += it }
        }
        job.invokeOnCompletion { jobs -= job }
        job.start()
    }

    override suspend fun connect(grant: SpeechGrant) {
        processor = grant.processorIdentity
        room.registerTextStreamHandler("bota.speech.v1") { receiver, sender ->
            if (retired || sender.value != processor || readers.incrementAndGet() > 8) {
                // End the room rather than leave an unconsumed peer stream allocating data.
                listener?.failed()
            } else observe {
                try {
                    withTimeout(5_000) {
                        val text = StringBuilder()
                        var bytes = 0
                        receiver.flow.collect { chunk ->
                            bytes += chunk.toByteArray(Charsets.UTF_8).size
                            check(bytes <= 32 * 1024)
                            text.append(chunk)
                        }
                        if (!retired) listener?.text(sender.value, text.toString())
                    }
                } finally { readers.decrementAndGet() }
            }
        }
        observe {
            room.events.collect { event ->
                if (!retired) when (event) {
                    is RoomEvent.TrackPublished -> subscribe(allowed)
                    is RoomEvent.TrackSubscribed -> attach(event.participant.identity?.value, event.publication.sid, event.track)
                    is RoomEvent.TrackUnsubscribed -> remove(event.publications.sid)
                    is RoomEvent.TrackUnpublished -> {
                        remove(event.publication.sid)
                        if (event.participant.identity?.value == processor) listener?.removed(event.publication.sid)
                    }
                    is RoomEvent.Reconnecting, is RoomEvent.Disconnected -> listener?.disconnected()
                    is RoomEvent.FailedToConnect, is RoomEvent.TrackSubscriptionFailed -> listener?.failed()
                    else -> Unit
                }
            }
        }
        withTimeout(8_000) { room.connect(grant.url, grant.token, ConnectOptions(autoSubscribe = false, audio = false, video = false)) }
        if (retired) room.disconnect()
    }

    private fun attach(sender: String?, sid: String, track: Track) {
        synchronized(sinks) {
            if (retired || sender != processor || sid !in allowed || track !is RemoteAudioTrack) return
            if (sinks[sid]?.track === track) return
            remove(sid)
            lateinit var sink: VendorPcmSink
            sink = VendorPcmSink(scope,
                accepts = { !retired && sid in allowed && sender == processor && sinks[sid]?.sink === sink },
                frame = { listener?.frame(sender, sid, it) },
                failed = { listener?.failed() })
            sinks[sid] = Sink(track, sink)
            track.addSink(sink)
            if (retired || sid !in allowed) remove(sid)
        }
    }

    private fun remove(sid: String) {
        synchronized(sinks) { sinks.remove(sid)?.let { it.track.removeSink(it.sink) } }
    }

    override fun subscribe(sids: Set<String>) {
        allowed = if (retired) emptySet() else sids.toSet()
        sinks.keys.toList().filter { it !in allowed }.forEach(::remove)
        for (participant in room.remoteParticipants.values) {
            for (publication in participant.trackPublications.values) {
                if (publication is RemoteTrackPublication) {
                    val desired = !retired && participant.identity?.value == processor &&
                        publication.kind == Track.Kind.AUDIO && publication.sid in allowed
                    if (publication.isDesired != desired) publication.setSubscribed(desired)
                    if (desired) publication.track?.let { attach(participant.identity?.value, publication.sid, it) }
                }
            }
        }
    }

    private inner class Input(val track: LocalAudioTrack) : RtcInput {
        override var enabled: Boolean
            get() = track.enabled
            set(value) {
                externalInput?.capture(value)
                room.setMicrophoneMute(externalInput != null || !value)
                track.enabled = value
            }
        override val sid: String? get() = room.localParticipant.trackPublications.values.firstOrNull { it.track === track }?.sid
        override fun dispose() {
            if (externalInput != null) { externalInput.capture(false); track.setAudioBufferCallback(null) }
            track.stop(); track.dispose()
        }
    }
    override suspend fun createInput(): RtcInput {
        val external = externalInput
        val track = room.localParticipant.createAudioTrack("bota-original", if (external == null)
            LocalAudioTrackOptions(echoCancellation = true, noiseSuppression = true, autoGainControl = true)
        else LocalAudioTrackOptions(echoCancellation = false, noiseSuppression = false, autoGainControl = false,
            highPassFilter = false, typingNoiseDetection = false))
        if (external != null) track.setAudioBufferCallback(object : AudioBufferCallback {
            override fun onBuffer(buffer: ByteBuffer, audioFormat: Int, channelCount: Int, sampleRate: Int, bytesRead: Int, captureTimeNs: Long): Long =
                external.render(buffer, audioFormat, channelCount, sampleRate, bytesRead)
        })
        return Input(track).also { it.enabled = false }
    }
    override suspend fun publish(input: RtcInput) {
        check(room.localParticipant.publishAudioTrack((input as Input).track,
            AudioTrackPublishOptions(name = "bota-original", source = Track.Source.MICROPHONE, preconnect = false)))
    }
    override fun unpublish(input: RtcInput) { room.localParticipant.unpublishTrack((input as Input).track) }
    override fun muteInput() { externalInput?.capture(false); room.setMicrophoneMute(true) }
    override fun disconnect() { room.disconnect() }
    override suspend fun release() {
        listener = null
        val pending = synchronized(jobs) { retired = true; jobs.toList() }
        pending.forEach { it.cancel() }
        pending.forEach { it.cancelAndJoin() }
        room.unregisterTextStreamHandler("bota.speech.v1")
        try { sinks.keys.toList().forEach(::remove) } finally { room.release() }
    }
}
