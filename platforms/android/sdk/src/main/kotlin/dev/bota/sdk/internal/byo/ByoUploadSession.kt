package dev.bota.sdk.internal.byo

import dev.bota.sdk.ByoStorageOptions
import dev.bota.sdk.ByoRecording
import dev.bota.sdk.ByoUploadResult
import dev.bota.sdk.internal.core.ByoRecoveryHost
import dev.bota.sdk.internal.jni.NativePacket
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.*
import org.json.JSONObject

internal class ByoUploadSession(private val options: ByoStorageOptions,private val recording: ByoRecording,
    private val ble: ByoDeviceLink,private val http: ByoControlClient,private val refresh: suspend ()->Unit,private val successor: JSONObject?=null): AutoCloseable {
    private val identity=org.json.JSONArray(listOf(options.baseUrl,options.scopeKey,options.organizationId,options.projectId,
        options.deviceId,options.environment,options.bindingGeneration.toString(),recording.uuid,recording.generation.toString())).toString()
    private val store=ByoDurableStore(File(options.stateDirectory,hex(MessageDigest.getInstance("SHA-256").digest(identity.toByteArray()))))
    private val docs: JSONObject
    private val recovery: ByoRecoveryHost
    private var fields=listOf<Pair<Int,Any>>()
    private var phase=0uL
    init {
        try {
            docs=store.load("documents")?.let {JSONObject(it.decodeToString())} ?: JSONObject()
            byoIdentity(recording.uuid,recording.generation)
            require(!docs.has("identity") || docs.getString("identity")==identity)
            docs.put("identity",identity)
            successor?.let { seed ->
                val context=seed.getJSONObject("context");scope(context)
                require(docs.optJSONObject("context")?.similar(context)!=false)
                docs.put("context",context).put("assembled",seed.getString("mode")=="assembled");persist()
            }
            recovery=ByoRecoveryHost({store.load("state")},{store.save("state",it)})
        } catch(error: Throwable) {store.close();throw error}
    }
    private fun persist()=store.save("documents",docs.toString().toByteArray())
    private fun packet(extra: List<Pair<Int,Any>> = emptyList()): NativePacket {
        val all=fields+extra
        return NativePacket(kind=0x052d,fieldIds=all.map {it.first}.toIntArray(),
            fieldTypes=all.map {if(it.second is String) 4 else 1}.toIntArray(),
            unsignedValues=all.map {if(it.second is Number) (it.second as Number).toLong() else 0L}.toLongArray(),
            signedValues=LongArray(all.size),dataValues=all.map {if(it.second is String) (it.second as String).toByteArray() else null}.toTypedArray())
    }
    private fun advance(command: Long,extra: List<Pair<Int,Any>> = emptyList()): ByoRecoveryHost.Decision =
        recovery.advance(packet(listOf(97 to command)+extra)).also {phase=it.phase}
    private fun scope(context: JSONObject) {
        require(context.getString("organization_id")==options.organizationId && context.getString("project_id")==options.projectId &&
            context.getString("device_id")==options.deviceId && context.getString("environment")==options.environment &&
            context.getLong("binding_generation")==options.bindingGeneration.toLong() && context.getString("recording_uuid")==recording.uuid &&
            context.getLong("recording_generation")==recording.generation.toLong() && context.getString("channel")=="ble")
        fields=listOf(205 to listOf("development","gamma","production").indexOf(options.environment),206 to options.organizationId,
            207 to options.projectId,208 to options.deviceId,209 to options.bindingGeneration.toLong(),
            210 to context.getLong("device_assignment_generation"),211 to context.getString("policy_revision"),13 to recording.uuid,129 to recording.generation.toLong())
    }
    private suspend fun rpc(operation: Int,body: ByteArray=byteArrayOf()): ByteArray {
        try {return ble.call(operation,body)} catch(e: ByoException) {
            if(e.reason!="context_expired") throw e
            refresh();return ble.call(operation,body)
        }
    }
    private suspend fun renew(endpoint: String) {
        val request=recovery.prepareRenewal(packet(),UUID.randomUUID().toString())
        val reply=http.control("$endpoint/recover",JSONObject().put("operation_id",request.operationId).put("expected_revision",request.expectedRevision.toLong()))
        require(reply.getString("operation_id")==request.operationId)
        docs.put("renewal",reply);persist()
        recovery.acceptRenewal(packet(),request,reply.getLong("revision").toULong())
    }
    suspend fun run(): ByoUploadResult {
        currentCoroutineContext().ensureActive();options.validateScope();refresh()
        val capabilities=JSONObject(rpc(1).decodeToString()).put("upload_modes",org.json.JSONArray(listOf("whole_file")))
            .put("durable_source",true).put("durable_receipt",true)
        val selected=http.control("/capabilities",capabilities)
        if(!docs.has("context") && !docs.optBoolean("selected_customer",false) && selected.getJSONObject("destination").getString("kind")!="customer") throw ByoException("not_selected")
        docs.put("selected_customer",true);persist()
        if(docs.has("context") && store.load("state")!=null) {
            val saved=docs.getJSONObject("context");scope(saved);advance(2)
            if(phase==9uL) return result(saved)
        }
        val facts=JSONObject(rpc(2,byoIdentity(recording.uuid,recording.generation)+byteArrayOf(1)).decodeToString())
        if(facts.optBoolean("missing",false)) {
            require(phase==8uL && docs.has("receipt") && docs.has("context"))
            val saved=docs.getJSONObject("context");val session=saved.getString("upload_session_id")
            require(UUID.fromString(session).toString()==session)
            val current=http.control("/$session").getJSONObject("receipt")
            check(docs.getJSONObject("receipt").similar(current) && advance(15).mayCleanup)
            advance(12);store.removeCiphertext();return result(saved)
        }
        require(facts.getString("recording_uuid")==recording.uuid && facts.getLong("recording_generation")==recording.generation.toLong())
        val length=facts.getLong("ciphertext_length");val hash=facts.getString("ciphertext_sha256")
        require(length in 293..134217728 && hash.matches(Regex("[0-9a-f]{64}")))
        val context=docs.optJSONObject("context") ?: http.control("",JSONObject(facts.toString()).put("channel","ble")).getJSONObject("context").also {
            scope(it);docs.put("context",it);persist()
        }
        scope(context);require(context.getLong("ciphertext_length")==length && context.getString("ciphertext_sha256")==hash)
        if(store.load("state")==null) advance(1) else advance(2)
        if(phase==9uL) return result(context)
        advance(6,listOf(130 to length,144 to hash))
        val session=context.getString("upload_session_id");require(UUID.fromString(session).toString()==session)
        val endpoint="/$session"
        if(advance(15).renewalOperation!=null) renew(endpoint)
        val prepared=http.control("$endpoint/prepare",JSONObject());val authorization=prepared.getJSONObject("authorization")
        docs.put("authorization",authorization);persist()
        if(phase==0uL) advance(3,listOf(212 to context.getString("recording_id"),213 to context.getString("configuration_id"),
            214 to context.getLong("configuration_revision"),215 to authorization.getString("configuration_sha256"),
            216 to context.getString("destination_ref"),217 to session,165 to context.getLong("owner_revision"),218 to 3))
        var upload=try {http.control("$endpoint/upload",JSONObject())} catch(e: ByoException) {
            if(e.status!=409 || e.reason!="expired") throw e
            renew(endpoint);http.control("$endpoint/upload",JSONObject())
        }
        var status=upload.getJSONObject("status")
        fun bundle(): JSONObject = JSONObject().put("context",context).put("authorization",authorization).apply {
            status.optJSONObject("receipt")?.let {receipt -> put("receipt",receipt)
                status.optJSONObject("recovery")?.optJSONObject("permit")?.let {put("recovery",it)}
            } ?: upload.optJSONObject("recovery")?.let {put("recovery",it)}
        }
        refresh()
        val opened=try {JSONObject(rpc(3,bundle().toString().toByteArray()).decodeToString())} catch(e: ByoException) {
            if(e.reason!="device_rejected") throw e
            renew(endpoint);upload=http.control("$endpoint/upload",JSONObject());status=upload.getJSONObject("status");refresh()
            JSONObject(rpc(3,bundle().toString().toByteArray()).decodeToString())
        }
        val manifest=opened.getJSONObject("manifest")
        require(docs.optJSONObject("manifest")?.similar(manifest)!=false)
        docs.put("manifest",manifest);persist()
        if(status.optJSONObject("receipt")==null && phase==5uL) {
            if(!docs.optBoolean("assembled")) upload.optJSONObject("upload")?.let {instructions ->download(length,hash);http.put(instructions,store.ciphertext())}
            advance(9)
        } else if(phase==5uL) advance(9)
        if(status.optJSONObject("receipt")==null) {
            for(poll in 0 until 24) {
                currentCoroutineContext().ensureActive()
                status=http.control("$endpoint/complete",JSONObject().put("manifest",manifest))
                if(status.optJSONObject("receipt")!=null) break
                if(status.optString("state") in listOf("failed","blocked")) throw ByoException("terminal_failure")
                if(poll<23) delay(5000)
            }
        }
        val receipt=status.optJSONObject("receipt") ?: throw ByoException("pending")
        docs.put("receipt",receipt);persist();refresh()
        val body=JSONObject().put("receipt",receipt)
        status.optJSONObject("recovery")?.optJSONObject("permit")?.let {body.put("recovery",it)}
        val digest=rpc(5,body.toString().toByteArray());require(digest.size==32);val receiptHash=hex(digest)
        require(!docs.has("receipt_sha256") || docs.getString("receipt_sha256")==receiptHash)
        docs.put("receipt_sha256",receiptHash);persist()
        if(phase==6uL) advance(10,listOf(162 to receiptHash))
        if(phase==7uL) advance(11,listOf(162 to receiptHash))
        check(advance(15).mayCleanup)
        rpc(6,digest);advance(12);store.removeCiphertext();return result(context)
    }
    private fun result(context: JSONObject)=ByoUploadResult(context.getString("recording_id"),context.getString("upload_session_id"))
    private suspend fun download(length: Long,hash: String) {
        store.createCiphertext().use {file ->
            val digest=MessageDigest.getInstance("SHA-256");var offset=0L;var refreshed=System.nanoTime()
            while(offset<length) {
                currentCoroutineContext().ensureActive()
                if(System.nanoTime()-refreshed>30_000_000_000L) {refresh();refreshed=System.nanoTime()}
                val count=minOf(4096,length-offset).toInt()
                val bytes=rpc(4,ByteBuffer.allocate(10).order(ByteOrder.LITTLE_ENDIAN).putLong(offset).putShort(count.toShort()).array())
                require(bytes.size==count);val buffer=ByteBuffer.wrap(bytes);while(buffer.hasRemaining()) file.write(buffer)
                digest.update(bytes);offset+=count
            }
            require(hex(digest.digest())==hash);file.force(true)
        }
    }
    override fun close() {try {recovery.close()} finally {store.close()}}
    companion object {private fun hex(bytes: ByteArray)=bytes.joinToString("") {"%02x".format(it.toInt() and 255)}}
}
