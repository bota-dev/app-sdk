package dev.bota.sdk.internal.byo

import dev.bota.sdk.ByoRecording
import dev.bota.sdk.ByoStorageOptions
import dev.bota.sdk.ByoUploadResult
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject

/** Live transport owns ciphertext only. Final authorization and deletion use Batch. */
internal class ByoStreamSession(private val options: ByoStorageOptions,private val recording: ByoRecording,
    private val ble: ByoDeviceLink,private val http: ByoControlClient,private val refresh: suspend ()->Unit): AutoCloseable {
    private val identity=byoIdentity(recording.uuid,recording.generation)
    private val scope=JSONArray(listOf(options.baseUrl,options.scopeKey,options.organizationId,options.projectId,options.deviceId,
        options.environment,options.bindingGeneration.toString(),recording.uuid,recording.generation.toString())).toString()
    private val store=ByoDurableStore(File(options.stateDirectory,"stream/"+hash(scope.toByteArray())))
    private val docs=try {store.load("documents")?.let {JSONObject(it.decodeToString())} ?: JSONObject()} catch(error: Throwable) {store.close();throw error}
    private fun persist()=store.save("documents",docs.toString().toByteArray())
    private suspend fun rpc(op: Int,body: ByteArray=identity): ByteArray {
        currentCoroutineContext().ensureActive();options.validateScope()
        return try {ble.call(op,body)} catch(error: ByoException) {
            if(error.reason!="context_expired") throw error
            refresh();ble.call(op,body)
        }
    }
    private fun validate(context: JSONObject) {
        require(context.getString("recording_uuid")==recording.uuid && context.getLong("recording_generation")==recording.generation.toLong() &&
            context.getString("organization_id")==options.organizationId && context.getString("project_id")==options.projectId &&
            context.getString("device_id")==options.deviceId && context.getString("environment")==options.environment &&
            context.getLong("binding_generation")==options.bindingGeneration.toLong() && context.getString("channel")=="ble")
        val id=context.getString("upload_session_id");require(UUID.fromString(id).toString()==id)
    }
    suspend fun run(): ByoUploadResult {
        var socket: ByoStreamSocket?=null
        try {
            refresh();require(!docs.has("scope") || docs.getString("scope")==scope);docs.put("scope",scope)
            docs.optJSONObject("successor")?.let {seed ->
                validate(seed.getJSONObject("context"))
                val result=ByoUploadSession(options,recording,ble,http,refresh,seed).use {it.run()}
                store.removeCiphertext();return result
            }
            val capability=JSONObject(rpc(1,byteArrayOf()).decodeToString());require(byoSupportsLive(capability))
            capability.put("upload_modes",JSONArray(listOf("whole_file","http_segments","ws_relay"))).put("durable_source",true).put("durable_receipt",true)
            val selected=http.control("/capabilities",capability)
            var facts=JSONObject(rpc(9).decodeToString())
            if(!docs.has("selected") && !facts.optBoolean("stream_selected") && selected.getJSONObject("destination").getString("kind")!="customer") throw ByoException("not_selected")
            val resumed=docs.has("selected") || facts.optBoolean("stream_selected")
            val modes=selected.getJSONArray("upload_modes");val allowed=(0 until modes.length()).map {modes.getString(it)}
            if(!resumed && !("whole_file" in allowed && "http_segments" in allowed)) throw ByoException("unsupported")
            docs.put("selected",true);persist();facts=JSONObject(rpc(9,identity+byteArrayOf(1)).decodeToString())
            val context=docs.optJSONObject("context") ?: facts.optJSONObject("stream_context") ?: http.streamControl("",JSONObject()
                .put("recording_uuid",recording.uuid).put("recording_generation",recording.generation.toLong()).put("channel","ble")
                .put("source_mode","durable").put("limits_profile","byo-stream-128m-4h-v1")).getJSONObject("context")
            validate(context);docs.put("context",context);persist();rpc(12,identity+context.toString().toByteArray())
            val endpoint="/"+context.getString("upload_session_id")
            // A restarted client fences the stream and uses its complete durable source.
            var fallback=resumed || docs.optBoolean("fallback")
            var offset=0L;var index=0;val started=System.nanoTime();var refreshed=started
            if(!fallback) {
                socket=try {if("ws_relay" in allowed) http.streamSocket(context.getString("upload_session_id")) else null} catch(error: CancellationException) {throw error} catch(_: Exception) {null}
                docs.put("transport",if(socket==null) "http" else "ws");persist()
            }
            while(true) {
                currentCoroutineContext().ensureActive()
                if(System.nanoTime()-started>14_400_000_000_000L) throw ByoException("recording_timeout")
                if(System.nanoTime()-refreshed>30_000_000_000L) {refresh();refreshed=System.nanoTime()}
                facts=JSONObject(rpc(9).decodeToString())
                require(facts.getString("recording_uuid")==recording.uuid && facts.getLong("recording_generation")==recording.generation.toLong())
                if(facts.getBoolean("failed")) throw ByoException("incomplete_recording")
                val length=facts.getLong("ciphertext_length");require(length in offset..134217728)
                val closed=facts.getBoolean("closed")
                if(facts.getBoolean("overflow") || facts.getLong("retained_offset")>offset) fallback=true
                val count=minOf(16384,length-offset).toInt()
                if(!fallback && count>0 && (count==16384 || closed)) {
                    val bytes=ByteArray(count)
                    try {
                        var copied=0
                        while(copied<count) {
                            val size=minOf(4096,count-copied)
                            val request=identity+ByteBuffer.allocate(6).order(ByteOrder.LITTLE_ENDIAN).putInt((offset+copied).toInt()).putShort(size.toShort()).array()
                            val chunk=rpc(10,request);require(chunk.size==size);chunk.copyInto(bytes,copied);copied+=size
                        }
                        val segment=JSONObject().put("index",index).put("offset",offset).put("length",count).put("sha256",hash(bytes))
                        if(docs.getString("transport")=="ws") {
                            while(true) {
                                try {requireNotNull(socket).exchange(segment,bytes);break}
                                catch(error: CancellationException) {throw error}
                                catch(error: Exception) {
                                    socket?.close();socket=null
                                    val retries=docs.optInt("reconnects");if(retries>=3) throw error
                                    docs.put("reconnects",retries+1);persist();delay(1000L shl retries)
                                    socket=try {http.streamSocket(context.getString("upload_session_id"))} catch(cancel: CancellationException) {throw cancel} catch(_: Exception) {null}
                                }
                            }
                        } else {
                            var proof=http.streamControl("$endpoint/grants",segment).getJSONObject("result")
                            require(proof.getJSONObject("segment").byoEquivalent(segment))
                            if(proof.getString("state")!="confirmed") {
                                require(proof.getString("state")=="write_authorized")
                                store.createCiphertext().use {file ->val buffer=ByteBuffer.wrap(bytes);while(buffer.hasRemaining()) file.write(buffer);file.force(true)}
                                http.put(proof.getJSONObject("grant"),store.ciphertext());proof=http.streamControl("$endpoint/confirm",segment).getJSONObject("result")
                            }
                            require(proof.getString("state")=="confirmed" && proof.getJSONObject("segment").byoEquivalent(segment))
                        }
                        offset+=count;index++;rpc(11,identity+ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(offset.toInt()).array())
                    } catch(error: CancellationException) {throw error}
                    catch(_: Exception) {fallback=true;docs.put("fallback",true);persist();socket?.close();socket=null}
                    finally {bytes.fill(0)}
                }
                if(closed && (fallback || offset==length)) break
                delay(100)
            }
            socket?.close();socket=null
            var status=http.streamControl(endpoint)
            if(status.optBoolean("recovery_required")) {
                val revision=status.getLong("recovery_revision")
                val operation=docs.optJSONObject("renewal")?.takeIf {it.getLong("expected_revision")==revision} ?: JSONObject()
                    .put("operation_id",UUID.randomUUID().toString()).put("expected_revision",revision).also {docs.put("renewal",it);persist()}
                http.streamControl("$endpoint/recover",operation);status=http.streamControl(endpoint)
            }
            if(status.getString("phase")!="handed_off") {
                val length=facts.getLong("ciphertext_length")
                val pending=status.optJSONObject("pending")?.takeIf {it.optString("operation")=="handoff"}
                val mode=pending?.getString("mode") ?: docs.optJSONObject("handoff")?.getString("mode") ?: if(!fallback && offset==length) "assembled" else "whole_file"
                val body=JSONObject().put("mode",mode).put("final",JSONObject().put("ciphertext_length",length)
                    .put("ciphertext_sha256",facts.getString("ciphertext_sha256")).put("segment_count",(length+16383)/16384))
                require(!docs.has("handoff") || docs.getJSONObject("handoff").byoEquivalent(body));docs.put("handoff",body);persist()
                status=http.streamControl("$endpoint/handoff",body)
            }
            val successor=status.getJSONObject("successor");validate(successor)
            val mode=status.getString("handoff_mode");require(mode in listOf("assembled","whole_file"))
            val seed=JSONObject().put("context",successor).put("mode",mode);docs.put("successor",seed);persist()
            rpc(13,identity+seed.toString().toByteArray())
            val result=ByoUploadSession(options,recording,ble,http,refresh,seed).use {it.run()}
            store.removeCiphertext();return result
        } finally {socket?.close()}
    }
    override fun close() {store.close()}
    companion object {private fun hash(bytes: ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") {"%02x".format(it.toInt() and 255)}}
}

internal fun byoSupportsLive(capability: JSONObject): Boolean {
    val modes=capability.optJSONArray("upload_modes") ?: return false
    return (0 until modes.length()).any {modes.optString(it)=="http_segments"}
}
