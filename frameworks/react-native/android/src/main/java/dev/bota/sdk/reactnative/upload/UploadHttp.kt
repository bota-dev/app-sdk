package dev.bota.sdk.reactnative.upload

import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject

internal class UploadOperation(val input: UploadInput) {
  private var cancelled = false
  private val cancellations = mutableSetOf<() -> Unit>()
  var registrationId: String? = null

  @Synchronized fun check() { if (cancelled) fail("CANCELLED") }
  @Synchronized fun <T> active(block: () -> T): T { check(); return block() }
  @Synchronized fun onCancel(callback: () -> Unit): () -> Unit {
    check()
    cancellations.add(callback)
    return { synchronized(this) { cancellations.remove(callback) }; Unit }
  }
  fun cancel() {
    val callbacks = synchronized(this) {
      if (cancelled) return
      cancelled = true
      cancellations.toList().also { cancellations.clear() }
    }
    callbacks.forEach { it() }
  }
}

internal class CredentialBroker(private val emit: (String, String) -> Unit) {
  private data class Pending(val operation: UploadOperation, val result: CompletableDeferred<String>)
  private val pending = mutableMapOf<String, Pending>()

  suspend fun request(operation: UploadOperation): String {
    operation.check()
    val requestId = UUID.randomUUID().toString()
    val result = CompletableDeferred<String>()
    val unregister = operation.onCancel { reject(requestId) }
    try {
      operation.active {
        synchronized(this) { pending[requestId] = Pending(operation, result) }
        emit(requestId, operation.input.operationId)
      }
      val token = withTimeoutOrNull(30_000) { result.await() } ?: fail("CREDENTIALS")
      operation.check()
      return token
    } catch (error: Exception) {
      operation.check()
      throw error
    } finally {
      unregister()
      synchronized(this) { pending.remove(requestId) }
    }
  }

  fun resolve(requestId: String, token: String) {
    val request = synchronized(this) { pending.remove(requestId) } ?: return
    try {
      request.operation.active {
        demand(token.length in 1..32768 && token.all { it.code in 33..126 }, "CREDENTIALS")
        request.result.complete(token)
      }
    } catch (error: UploadFailure) { request.result.completeExceptionally(error) }
  }

  fun reject(requestId: String) {
    val request = synchronized(this) { pending.remove(requestId) } ?: return
    request.result.completeExceptionally(UploadFailure("BOTA_UPLOAD_CREDENTIALS"))
  }
}

internal class UploadRequest(
  val origin: String, val path: String, val method: String, val headers: Map<String, String>, val body: JSONObject?,
) {
  override fun toString(): String = "UploadRequest(<redacted>)"
}

internal interface UploadHttp {
  suspend fun execute(request: UploadRequest, operation: UploadOperation, retain: Boolean,
    beforeDispatch: () -> Unit = {}): JSONObject
}

/** Dedicated client: no app network recorder, auth interceptor, redirects, or automatic POST retry. */
internal class BackendUploadHttp(private val client: OkHttpClient = OkHttpClient.Builder()
  .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
  .connectTimeout(20, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(45, TimeUnit.SECONDS).build()) : UploadHttp {
  override suspend fun execute(request: UploadRequest, operation: UploadOperation, retain: Boolean,
    beforeDispatch: () -> Unit): JSONObject = withContext(if (retain) NonCancellable else kotlin.coroutines.EmptyCoroutineContext) {
    try {
      val nativeRequest = Request.Builder().url(request.origin + request.path).apply {
        request.headers.forEach { (key, value) -> header(key, value) }
        method(request.method, request.body?.toString()?.toRequestBody("application/json".toMediaType()))
      }.build()
      val call = client.newCall(nativeRequest)
      suspendCancellableCoroutine { continuation ->
        var unregister: (() -> Unit)? = null
        continuation.invokeOnCancellation { call.cancel() }
        try {
          operation.active {
            if (!retain) unregister = operation.onCancel { call.cancel() }
            beforeDispatch()
            call.enqueue(object : Callback {
              override fun onFailure(call: Call, e: IOException) {
                unregister?.invoke()
                if (continuation.isActive) continuation.resumeWithException(UploadFailure("BOTA_UPLOAD_TRANSPORT"))
              }
              override fun onResponse(call: Call, response: Response) {
                val value = runCatching {
                  response.use {
                    if (!response.isSuccessful && response.code != 401 && response.code != 403 && response.code != 409) fail("HTTP_${response.code}")
                    val body = response.body ?: fail("INVALID_DOCUMENT")
                    demand(body.contentLength() <= 65536, "INVALID_DOCUMENT")
                    // Read a bounded body here, before completing the retained request.
                    val source = body.source()
                    source.request(65537)
                    demand(source.buffer.size <= 65536, "INVALID_DOCUMENT")
                    val text = source.readUtf8()
                    if (response.code == 409 && runCatching {
                      JSONObject(text).optJSONObject("error")?.optString("code") == "encrypted_upload_v2_staging_missing"
                    }.getOrDefault(false)) fail("STAGING_MISSING")
                    if (!response.isSuccessful) fail("HTTP_${response.code}")
                    if (text.isEmpty()) JSONObject() else sanitized("INVALID_DOCUMENT") { JSONObject(text) }
                  }
                }
                unregister?.invoke()
                if (continuation.isActive) value.fold({ continuation.resume(it) }, {
                  continuation.resumeWithException(if (it is UploadFailure) it else UploadFailure("BOTA_UPLOAD_TRANSPORT"))
                })
              }
            })
          }
        } catch (error: Exception) {
          unregister?.invoke()
          if (continuation.isActive) continuation.resumeWithException(
            if (error is UploadFailure) error else UploadFailure("BOTA_UPLOAD_TRANSPORT"))
        }
      }
    } catch (error: Exception) {
      if (!retain) operation.check()
      if (error is UploadFailure) throw error
      fail("TRANSPORT")
    }
  }
}
