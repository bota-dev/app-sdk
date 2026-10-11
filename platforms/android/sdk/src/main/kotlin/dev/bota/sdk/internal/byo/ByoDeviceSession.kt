package dev.bota.sdk.internal.byo

import dev.bota.sdk.ByoRecording
import dev.bota.sdk.ByoStorageOptions
import dev.bota.sdk.ByoUploadResult
import dev.bota.sdk.internal.DeviceRuntime
import dev.bota.sdk.internal.bluetooth.BotaBluetoothUUIDs
import dev.bota.sdk.model.ConnectedDevice
import kotlinx.coroutines.*

internal object ByoDeviceSession {
    suspend fun run(runtime: DeviceRuntime,device: ConnectedDevice,recording: ByoRecording?,options: ByoStorageOptions,live: Boolean=false,
        validateOwner: suspend ()->Unit): ByoUploadResult=withLink(runtime,device,options,validateOwner) {ble,http,refresh ->
            refresh()
            val recording=recording ?: run {
                require(live);val current=org.json.JSONObject(ble.call(9).decodeToString())
                require(!current.getBoolean("closed"));val generation=current.getLong("recording_generation");require(generation in 1..0xffffffffL)
                ByoRecording(current.getString("recording_uuid"),generation.toUInt())
            }
            val capability=org.json.JSONObject(ble.call(1).decodeToString())
            val selected=if(byoSupportsLive(capability)) try {
                org.json.JSONObject(ble.call(9,byoIdentity(recording.uuid,recording.generation)).decodeToString()).optBoolean("stream_selected")
            } catch(error: ByoException) {if(error.reason!="device_rejected") throw error;false} else false
            if(live || selected) ByoStreamSession(options,recording,ble,http,refresh).use {it.run()}
            else ByoUploadSession(options,recording,ble,http,refresh).use {it.run()}
        }
    suspend fun list(runtime: DeviceRuntime,device: ConnectedDevice,options: ByoStorageOptions,
        validateOwner: suspend ()->Unit): List<ByoRecording> = withLink(runtime,device,options,validateOwner) {ble,_,refresh ->
            refresh();var cursor=0L;val result=linkedMapOf<String,ByoRecording>();var refreshed=System.nanoTime()
            for(step in 0..4096) {
                if(System.nanoTime()-refreshed>30_000_000_000L) {refresh();refreshed=System.nanoTime()}
                val request=java.nio.ByteBuffer.allocate(4).order(java.nio.ByteOrder.LITTLE_ENDIAN).putInt(cursor.toInt()).array()
                val bytes=try {ble.call(8,request)} catch(error: ByoException) {
                    if(error.reason!="context_expired") throw error
                    refresh();ble.call(8,request)
                }
                val reply=org.json.JSONObject(bytes.decodeToString())
                val next=reply.getLong("next");require(next in 0..0xffffffffL)
                reply.optJSONObject("recording")?.let {
                    val uuid=it.getString("recording_uuid");val generation=it.getLong("recording_generation")
                    require(java.util.UUID.fromString(uuid).toString()==uuid && generation in 0..0xffffffffL)
                    result["$uuid:$generation"]=ByoRecording(uuid,generation.toUInt())
                }
                if(next==0L) return@withLink result.values.toList()
                require(next>cursor);cursor=next
            }
            throw ByoException("catalog_limit")
        }
    private suspend fun <T> withLink(runtime: DeviceRuntime,device: ConnectedDevice,options: ByoStorageOptions,
        validateOwner: suspend ()->Unit,body: suspend (ByoBLEHost,ByoHTTP,suspend ()->Unit)->T): T=coroutineScope {
        val generation=runtime.connection.generation(device)
        val validate: suspend ()->Unit = {
            currentCoroutineContext().ensureActive();validateOwner();options.validateScope();runtime.connection.require(device,generation)
        }
        val http=ByoHTTP(options)
        val ble=ByoBLEHost(runtime.encryptedUploadV2MaximumWriteLength(device.id),
            write={runtime.directWrite(device.id,BotaBluetoothUUIDs.StorageService,BotaBluetoothUUIDs.TransferControlV2,it)},
            subscribe={runtime.directSubscribe(device.id,BotaBluetoothUUIDs.StorageService,BotaBluetoothUUIDs.RecordingTransferV2)},
            unsubscribe={runtime.directUnsubscribe(device.id,BotaBluetoothUUIDs.StorageService,BotaBluetoothUUIDs.RecordingTransferV2)},validate=validate)
        val refresh: suspend ()->Unit = {validate();runtime.byoRefreshContext(http::contextExchange);validate()}
        try {validate();ble.start(this);val result=body(ble,http,refresh);ble.call(7);ble.close();result}
        catch(error: Throwable) {
            withContext(NonCancellable) {
                val aborted=runCatching {ble.call(7)}.isSuccess
                val closed=runCatching {ble.close()}.isSuccess
                if(!aborted || !closed) runCatching {runtime.disconnect(device.id)}
            }
            throw error
        }
    }
}
