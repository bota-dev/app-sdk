package dev.bota.speech.companion

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal class NativeLabTransport : LabTransport {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).callTimeout(8, TimeUnit.SECONDS).connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS).cache(null).build()
    override suspend fun send(request: LabRequest): LabResponse = suspendCancellableCoroutine { waiting ->
        val builder = Request.Builder().url(request.url).post(request.body.toRequestBody())
        request.headers.forEach { (name, value) -> builder.header(name, value) }
        val call = client.newCall(builder.build())
        waiting.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) { waiting.resumeWithException(LabFailure()) }
            override fun onResponse(call: Call, response: Response) {
                try {
                    val result = response.use {
                        val body = it.body ?: throw LabFailure()
                        if (body.contentLength() > 524_288) throw LabFailure()
                        val bytes = ByteArrayOutputStream()
                        body.byteStream().use { stream ->
                            val chunk = ByteArray(8192)
                            while (true) {
                                if (call.isCanceled()) throw LabFailure()
                                val count = stream.read(chunk)
                                if (count < 0) break
                                if (bytes.size() + count > 524_288) throw LabFailure()
                                bytes.write(chunk, 0, count)
                            }
                        }
                        val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
                        LabResponse(it.code, text)
                    }
                    waiting.resume(result)
                } catch (_: Exception) { waiting.resumeWithException(LabFailure()) }
            }
        })
    }
    override fun close() {
        client.dispatcher.cancelAll()
        client.connectionPool.evictAll()
        client.dispatcher.executorService.shutdown()
    }
}
