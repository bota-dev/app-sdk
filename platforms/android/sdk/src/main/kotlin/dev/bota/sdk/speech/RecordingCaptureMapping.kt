package dev.bota.sdk.speech

import org.json.JSONArray
import org.json.JSONObject

public data class RecordingCaptureGap(public val offset: Int, public val samples: Int)
/** Original samples before resampling onto the common 48 kHz recording clock.
 * Missing frames are explicit gaps with zero container padding. */
public data class RecordingCaptureMapping(
    public val sourceClockId: String, public val sourceEpoch: Long, public val firstSample: Long, public val samples: Int,
    public val sampleRate: Int, public val revision: Long, public val discontinuity: Boolean,
    public val gaps: List<RecordingCaptureGap> = emptyList(),
) {
    internal fun json(): JSONObject = JSONObject().put("sourceClockId", sourceClockId).put("sourceEpoch", sourceEpoch)
        .put("firstSample", firstSample).put("samples", samples).put("sampleRate", sampleRate).put("revision", revision)
        .put("discontinuity", discontinuity).put("gaps", JSONArray().apply {
            gaps.forEach { put(JSONObject().put("offset", it.offset).put("samples", it.samples)) }
        })
}
