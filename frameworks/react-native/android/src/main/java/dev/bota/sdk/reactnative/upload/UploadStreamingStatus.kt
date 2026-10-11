package dev.bota.sdk.reactnative.upload

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject

/** Read-only native HTTP boundary. Never sends opaque server fields over RN. */
internal class UploadStreamingStatus(private val client: OkHttpClient = OkHttpClient.Builder()
  .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
  .connectTimeout(20, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(45, TimeUnit.SECONDS).build()) {
  suspend fun read(input: String): String {
    val json = sanitized("INVALID_INPUT") { JSONObject(input) }
    val url = json.optString("url")
    val token = json.optString("token")
    val org = json.optString("organizationId")
    demand(url.matches(Regex("https://[A-Za-z0-9.-]+(?::[0-9]+)?(?:/[A-Za-z0-9_-]+)+/recordings/rec_[A-Za-z0-9_-]+/streaming-status\\?session_id=[0-9a-f-]{36}")), "INVALID_INPUT")
    demand(token.length in 1..16384 && token.all { it.code in 33..126 } &&
      (org.isEmpty() || org.matches(Regex("[A-Za-z0-9_-]{1,128}"))), "INVALID_INPUT")
    val request = Request.Builder().url(url).get().header("Authorization", "Bearer $token")
      .header("Accept", "application/json").apply { if (org.isNotEmpty()) header("X-Organization-Id", org) }.build()
    val call = client.newCall(request)
    return suspendCancellableCoroutine { continuation ->
      continuation.invokeOnCancellation { call.cancel() }
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          if (continuation.isActive) continuation.resumeWithException(UploadFailure("BOTA_UPLOAD_TRANSPORT"))
        }
        override fun onResponse(call: Call, response: Response) {
          val result = runCatching {
            response.use {
              demand(response.code == 200 && response.request.url == request.url, "HTTP_${response.code}")
              val body = response.body ?: fail("INVALID_DOCUMENT")
              demand(body.contentLength() <= 16384, "INVALID_DOCUMENT")
              val source = body.source(); source.request(16385)
              demand(source.buffer.size <= 16384, "INVALID_DOCUMENT")
              scalarStatus(source.readUtf8())
            }
          }
          if (continuation.isActive) result.fold({ continuation.resume(it) },
            { continuation.resumeWithException(if (it is UploadFailure) it else UploadFailure("BOTA_UPLOAD_INVALID_DOCUMENT")) })
        }
      })
    }
  }

  companion object {
    private val stringFields = setOf("profile", "recording_id", "session_id", "writer_epoch", "revision", "state")
    private val numberFields = setOf("recording_generation", "received_count", "contiguous_sequence")
    fun scalarStatus(body: String): String {
      val json = sanitized("INVALID_DOCUMENT") { JSONObject(body) }
      demand(json.keys().asSequence().toSet() == stringFields + numberFields + setOf("expected_count", "authorization_expired"), "INVALID_DOCUMENT")
      stringFields.forEach { demand(json.get(it) is String && (json.get(it) as String).length <= 160, "INVALID_DOCUMENT") }
      numberFields.forEach { demand(json.get(it) is Number, "INVALID_DOCUMENT") }
      demand(json.isNull("expected_count") || json.get("expected_count") is Number, "INVALID_DOCUMENT")
      demand(json.get("authorization_expired") is Boolean, "INVALID_DOCUMENT")
      return json.toString()
    }
  }
}
