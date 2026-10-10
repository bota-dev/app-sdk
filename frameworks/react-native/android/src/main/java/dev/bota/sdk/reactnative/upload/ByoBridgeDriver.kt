package dev.bota.sdk.reactnative.upload

import dev.bota.sdk.*
import dev.bota.sdk.model.*
import java.io.File
import java.util.UUID
import kotlinx.coroutines.*
import org.json.JSONObject

/** RN passes only identity metadata; all signed material and audio remain native. */
internal class ByoBridgeDriver(private val root: File,private val emit: (String,String)->Unit) {
    private val lock=Any()
    private val tasks=mutableMapOf<String,Job>()
    private val cancelled=mutableSetOf<String>()
    private var stopped=false
    private data class Pending(val owner: String,val value: CompletableDeferred<String>)
    private val pending=mutableMapOf<String,Pending>()
    private fun check(id: String)=synchronized(lock) {demand(!stopped && id !in cancelled && tasks.containsKey(id),"CANCELLED")}
    suspend fun sync(json: String): String=coroutineScope {
        demand(json.toByteArray().size<=8192,"INVALID_INPUT")
        val input=JSONObject(json);val id=input.getString("operationId")
        val job=currentCoroutineContext()[Job]!!
        synchronized(lock) {
            demand(id.startsWith("byo-") && id.length<=64 && !stopped && id !in cancelled && !tasks.containsKey(id),"INVALID_INPUT")
            tasks[id]=job
        }
        try {
            val value=input.getJSONObject("device");val scope=input.getJSONObject("scope");val recording=input.optJSONObject("recording")
            val type=when(value.getString("deviceType")) {"bota_pin"->DeviceType.BotaPin;"bota_pin_4g"->DeviceType.BotaPin4G;"bota_note"->DeviceType.BotaNote;else->fail("INVALID_INPUT")}
            demand(value.getString("connectionState")=="connected" && value.getInt("mtu") in 23..517,"INVALID_INPUT")
            val device=ConnectedDevice(value.getString("id"),value.getString("serialNumber"),type,value.getString("firmwareVersion"),
                if(value.isNull("hardwareRevision")) null else value.optString("hardwareRevision",null),
                value.getBoolean("isProvisioned"),ConnectionState.Connected,value.getInt("mtu"))
            val binding=scope.getLong("bindingGeneration");val generation=recording?.getLong("generation") ?: 0
            demand(binding in 1..0xffffffffL && generation in 0..0xffffffffL,"INVALID_INPUT")
            val options=ByoStorageOptions(scope.getString("baseUrl"),scope.getString("scopeKey"),scope.getString("organizationId"),
                scope.getString("projectId"),scope.getString("deviceId"),scope.getString("environment"),binding.toUInt(),root,
                {token(id)},{currentCoroutineContext().ensureActive();check(id)})
            if(input.getString("mode")=="list") {
                val values=BotaDeviceClient.shared.recordings.listByoRecordings(device,options);check(id)
                org.json.JSONArray(values.map {JSONObject().put("uuid",it.uuid).put("generation",it.generation.toLong())}).toString()
            } else {
                demand(input.getString("mode")=="stream" || (input.getString("mode")=="sync" && recording!=null),"INVALID_INPUT")
                val selected=recording?.let {ByoRecording(it.getString("uuid"),generation.toUInt())}
                val result=if(input.getString("mode")=="stream") BotaDeviceClient.shared.recordings.streamByoRecording(device,selected,options)
                    else BotaDeviceClient.shared.recordings.syncByoRecording(device,requireNotNull(selected),options)
                check(id)
                JSONObject().put("recordingId",result.recordingId).put("uploadSessionId",result.uploadSessionId).toString()
            }
        } finally {
            synchronized(lock) {tasks.remove(id);cancelled.remove(id)
                pending.filterValues {it.owner==id}.keys.toList().forEach {pending.remove(it)?.value?.cancel()}}
        }
    }
    private suspend fun token(id: String): String {
        check(id);val request=UUID.randomUUID().toString();val value=CompletableDeferred<String>()
        synchronized(lock) {check(id);pending[request]=Pending(id,value)}
        try {emit(request,id);return withTimeout(30_000) {value.await()}.also {check(id)}}
        finally {synchronized(lock) {pending.remove(request)}}
    }
    fun resolve(request: String,token: String) {
        val entry=synchronized(lock) {pending.remove(request)} ?: return
        if(token.isNotEmpty() && token.length<=16384 && token.all {it.code in 33..126}) entry.value.complete(token)
        else entry.value.completeExceptionally(UploadFailure("BOTA_UPLOAD_CREDENTIALS"))
    }
    fun reject(request: String) {synchronized(lock) {pending.remove(request)}?.value?.completeExceptionally(UploadFailure("BOTA_UPLOAD_CREDENTIALS"))}
    suspend fun cancel(id: String) {
        val task=synchronized(lock) {
            if(!id.startsWith("byo-") || id.length>64) return
            if(cancelled.size>=128) stopped=true else cancelled.add(id)
            tasks[id]
        }
        task?.cancelAndJoin()
    }
    suspend fun stop() {
        val current=synchronized(lock) {stopped=true;tasks.values.toList()}
        current.forEach {it.cancel()};current.forEach {it.join()}
    }
}
