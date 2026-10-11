package dev.bota.sdk.internal.byo

import dev.bota.sdk.ByoStorageOptions
import dev.bota.sdk.EncryptedUploadV2ContextExchange
import java.io.File
import java.io.IOException
import java.util.Base64
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

internal interface ByoStreamSocket {
    suspend fun exchange(segment: JSONObject,bytes: ByteArray): JSONObject
    fun close()
}
internal interface ByoControlClient {
    suspend fun control(suffix: String, body: JSONObject?=null, context: Boolean=false): JSONObject
    suspend fun put(instructions: JSONObject, file: File)
    suspend fun streamControl(suffix: String,body: JSONObject?=null): JSONObject = throw ByoException("unsupported")
    suspend fun streamSocket(session: String): ByoStreamSocket = throw ByoException("unsupported")
}
internal class ByoHTTP(private val options: ByoStorageOptions): ByoControlClient {
    private val base=options.baseUrl.trimEnd('/').toHttpUrl()
    private val client=OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).cookieJar(CookieJar.NO_COOKIES)
        .connectTimeout(30,TimeUnit.SECONDS).readTimeout(30,TimeUnit.SECONDS).writeTimeout(30,TimeUnit.SECONDS)
        .callTimeout(10,TimeUnit.MINUTES).build()
    init {
        require(base.isHttps && base.username.isEmpty() && base.password.isEmpty() && base.query==null && base.fragment==null)
        require(options.scopeKey.isNotEmpty() && options.bindingGeneration>0u)
        require(listOf(options.deviceId,options.projectId,options.organizationId).all { it.matches(Regex("[A-Za-z0-9_-]{1,128}")) })
        require(options.environment in listOf("development","gamma","production"))
    }
    override suspend fun control(suffix: String, body: JSONObject?, context: Boolean): JSONObject = request(suffix,body,if(context) "encrypted-upload-v2/contexts" else "byo-uploads")
    override suspend fun streamControl(suffix: String,body: JSONObject?): JSONObject = request(suffix,body,"byo-streams")
    private suspend fun request(suffix: String,body: JSONObject?,route: String): JSONObject {
        require(suffix.matches(Regex("[A-Za-z0-9_/-]*")))
        val url=base.newBuilder().addPathSegment("devices").addPathSegment(options.deviceId)
            .addPathSegments(route)
            .apply {if(suffix.isNotEmpty()) addPathSegments(suffix.trimStart('/'))}.build()
        repeat(3) { attempt ->
            currentCoroutineContext().ensureActive();options.validateScope()
            val token=options.accessToken()
            require(token.isNotEmpty() && token.length<=16384 && token.all {it.code in 33..126})
            val request=Request.Builder().url(url).header("Authorization","Bearer $token")
                .header("x-bota-device-binding",options.bindingGeneration.toString()).header("x-organization-id",options.organizationId)
                .apply {if(body!=null) post(body.toString().toRequestBody("application/json".toMediaType()))}.build()
            val reply=send(request);currentCoroutineContext().ensureActive();options.validateScope()
            if(reply.first in 200..299) return JSONObject(reply.second.decodeToString()).getJSONObject("data")
            val pause=byoRetryDelay(reply.third,(attempt+1)*2000L)
            if(attempt<2 && pause!=null && (reply.first in setOf(425,429) || reply.first>=500)) delay(pause)
            else {
                val expired=reply.first==409 && runCatching {JSONObject(reply.second.decodeToString()).getJSONObject("error").getString("code")=="expired"}.getOrDefault(false)
                throw ByoException(if(expired) "expired" else "http",reply.first)
            }
        }
        throw ByoException("pending")
    }
    override suspend fun put(instructions: JSONObject, file: File) {
        require(instructions.getString("method")=="PUT")
        val text=instructions.getString("url");require(text.length<=8192)
        val url=text.toHttpUrl();require(url.isHttps && url.username.isEmpty() && url.password.isEmpty() && url.fragment==null)
        val request=Request.Builder().url(url).put(file.asRequestBody("application/octet-stream".toMediaType()))
        val headers=instructions.getJSONObject("headers")
        for(name in headers.keys()) {
            val value=headers.getString(name);require(value.length<=256 && '\r' !in value && '\n' !in value)
            when(name) {
                "content-type" -> require(value=="application/octet-stream")
                "x-amz-checksum-sha256" -> require(Base64.getDecoder().decode(value).size==32)
                "x-ms-blob-type" -> require(value=="BlockBlob")
                else -> throw ByoException("invalid_headers")
            }
            request.header(name,value)
        }
        currentCoroutineContext().ensureActive();options.validateScope()
        val result=send(request.build());currentCoroutineContext().ensureActive();options.validateScope()
        if(result.first !in 200..299) throw ByoException("http",result.first)
    }
    override suspend fun streamSocket(session: String): ByoStreamSocket {
        require(UUID.fromString(session).toString()==session)
        options.validateScope();val token=options.accessToken()
        require(token.isNotEmpty() && token.length<=16384 && token.all {it.code in 33..126})
        val request=Request.Builder().url(base.newBuilder().addPathSegment("devices").addPathSegment(options.deviceId).addPathSegments("byo-streams/ws").build())
            .header("Authorization","Bearer $token").header("x-bota-device-binding",options.bindingGeneration.toString())
            .header("x-organization-id",options.organizationId).header("Sec-WebSocket-Protocol","bota-byo-stream-v1").build()
        val messages=kotlinx.coroutines.channels.Channel<String>(4)
        val opened=CompletableDeferred<Unit>()
        val socket=client.newWebSocket(request,object: WebSocketListener() {
            override fun onOpen(webSocket: WebSocket,response: Response) {
                if(response.header("Sec-WebSocket-Protocol")!="bota-byo-stream-v1") {opened.completeExceptionally(ByoException("protocol"));webSocket.cancel()}
                else opened.complete(Unit)
            }
            override fun onMessage(webSocket: WebSocket,text: String) {
                if(text.toByteArray().size>32768 || !messages.trySend(text).isSuccess) {messages.close(ByoException("backpressure"));webSocket.cancel()}
            }
            override fun onMessage(webSocket: WebSocket,bytes: okio.ByteString) {messages.close(ByoException("protocol"));webSocket.cancel()}
            override fun onFailure(webSocket: WebSocket,t: Throwable,response: Response?) {val error=ByoException("network");opened.completeExceptionally(error);messages.close(error)}
            override fun onClosed(webSocket: WebSocket,code: Int,reason: String) {messages.close(ByoException("network"))}
            override fun onClosing(webSocket: WebSocket,code: Int,reason: String) {webSocket.close(code,null);messages.close(ByoException("network"))}
        })
        try {
            withTimeout(30000) {opened.await();check(socket.send(JSONObject().put("type","resume").put("session_id",session).toString()))
                val ready=JSONObject(messages.receive());require(ready.getString("type")=="ready" && ready.getString("session_id")==session)}
            options.validateScope()
        } catch(error: Throwable) {socket.cancel();messages.cancel();throw error}
        return object: ByoStreamSocket {
            override suspend fun exchange(segment: JSONObject,bytes: ByteArray): JSONObject {
                currentCoroutineContext().ensureActive();options.validateScope()
                val header=segment.toString().toByteArray();require(header.size<=1024 && bytes.size<=16384)
                val frame=java.nio.ByteBuffer.allocate(4+header.size+bytes.size).putInt(header.size).put(header).put(bytes).array()
                try {return withTimeout(30000) {
                    check(socket.send(okio.ByteString.of(*frame)));val ack=JSONObject(messages.receive())
                    require(ack.getString("type")=="ack" && ack.getString("session_id")==session && ack.getJSONObject("segment").byoEquivalent(segment))
                    options.validateScope();ack
                }} finally {frame.fill(0)}
            }
            override fun close() {socket.cancel();messages.cancel()}
        }
    }
    private suspend fun send(request: Request): Triple<Int,ByteArray,String?> = suspendCancellableCoroutine { continuation ->
        val call=client.newCall(request);continuation.invokeOnCancellation {call.cancel()}
        call.enqueue(object: Callback {
            override fun onFailure(call: Call,e: IOException) {if(continuation.isActive) continuation.resumeWithException(ByoException("network"))}
            override fun onResponse(call: Call,response: Response) {
                try {
                    response.use {
                        val output=java.io.ByteArrayOutputStream();val buffer=ByteArray(4096)
                        response.body?.byteStream()?.use {input ->
                            while(true) {val count=input.read(buffer);if(count<0) break
                                if(output.size()+count>32768) throw ByoException("response_too_large");output.write(buffer,0,count)}
                        }
                        if(continuation.isActive) continuation.resume(Triple(response.code,output.toByteArray(),response.header("Retry-After")))
                    }
                } catch(e: Throwable) {if(continuation.isActive) continuation.resumeWithException(ByoException("network"))}
            }
        })
    }
    suspend fun contextExchange(nonce: ByteArray): EncryptedUploadV2ContextExchange {
        require(nonce.size==16)
        val initial=control("",JSONObject().put("nonce_base64",Base64.getEncoder().encodeToString(nonce)),true)
        val id=initial.getString("context_id");require(UUID.fromString(id).toString()==id)
        val encoded=initial.getString("challenge_base64");val challenge=Base64.getDecoder().decode(encoded);require(challenge.size==196)
        return EncryptedUploadV2ContextExchange(challenge) { proof ->
            require(proof.size in 116..366)
            var reply=control("/$id/proof",JSONObject().put("proof_base64",Base64.getEncoder().encodeToString(proof)),true)
            var result: ByteArray?=null
            for(poll in 0 until 100) {
                require(reply.getString("context_id")==id && reply.getString("challenge_base64")==encoded)
                if(reply.getString("state")=="complete") {result=Base64.getDecoder().decode(reply.getString("result_base64"));break}
                require(reply.getString("state")=="pending");delay(250);reply=control("/$id",context=true)
            }
            result?.also {require(it.size==264)} ?: throw ByoException("context_timeout")
        }
    }
}

/** Park long backoffs for the host; never cap them into an early retry. */
internal fun byoRetryDelay(header: String?,fallbackMs: Long,nowMs: Long=System.currentTimeMillis()): Long? {
    val value=header?.trim()
    val seconds=value?.toDoubleOrNull()
    val milliseconds=if(seconds!=null && seconds.isFinite() && seconds>=0) seconds*1000 else
        runCatching {java.time.ZonedDateTime.parse(value,java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME)
            .toInstant().toEpochMilli().toDouble()-nowMs}.getOrNull()
    val wait=maxOf(fallbackMs.toDouble(),milliseconds ?: 0.0)
    return if(wait>30000) null else kotlin.math.ceil(wait).toLong()
}
