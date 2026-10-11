package dev.bota.sdk.internal.byo

import dev.bota.sdk.*
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ByoUploadSessionTest {
    private class Fixture(size: Int=300) {
        val root=Files.createTempDirectory("byo-host-test-").toFile()
        val bytes=ByteArray(size){it.toByte()}
        val hash=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") {"%02x".format(it.toInt() and 255)}
        val context=JSONObject("""{"contract_version":"bota-byo-batch-control-v1","environment":"development","organization_id":"org_test","project_id":"proj_test","configuration_id":"310eec75-feb0-487b-9d05-2d21c0b18794","configuration_revision":1,"destination_ref":"archive","recording_id":"rec_test","recording_uuid":"00112233-4455-6677-8899-aabbccddeeff","recording_generation":9,"device_id":"dev_test","binding_generation":1,"device_assignment_generation":1,"upload_session_id":"cde68c61-db75-43c8-8112-623ad29a2f13","owner_revision":1,"policy_revision":"1","channel":"ble","file_profile":"botaenc2-batch","ciphertext_length":300}""").put("ciphertext_sha256",hash).put("ciphertext_length",bytes.size)
        val calls=mutableListOf<String>();var committed=false;var loseCompletion=false;var rejectReceipt=false;var loseConfirm=false;var removed=false
        var expired=false;var loseRenewal=false;var loseCreate=false;var conflict=false
        val renewals=mutableListOf<String>();val createBodies=mutableListOf<String>()
        val options=ByoStorageOptions("https://customer.example/v1","account-a","org_test","proj_test","dev_test","development",1u,root,{"app-token"},{})
        val recording=ByoRecording(context.getString("recording_uuid"),9u)
        val auth=JSONObject().put("configuration_sha256","ab".repeat(32))
        val receipt=JSONObject().put("signed","fake-device-verified-evidence")
        fun status()=JSONObject().put("state",if(committed) "completed" else "receiving").apply {if(committed) put("receipt",receipt)}
        val http=object: ByoControlClient {
            override suspend fun control(suffix: String,body: JSONObject?,context: Boolean): JSONObject {
                calls+="http:$suffix"
                return when {
                    suffix=="/capabilities" -> JSONObject().put("destination",JSONObject().put("kind","customer")).put("upload_modes",org.json.JSONArray(listOf("whole_file","http_segments","ws_relay")))
                    suffix=="" -> {createBodies+=requireNotNull(body).toString();if(loseCreate){loseCreate=false;throw ByoException("network")};JSONObject().put("context",this@Fixture.context)}
                    suffix.endsWith("/recover") -> {
                        renewals+=requireNotNull(body).toString()
                        if(loseRenewal){loseRenewal=false;throw ByoException("network")}
                        expired=false
                        JSONObject().put("operation_id",body.getString("operation_id")).put("revision",body.getLong("expected_revision")+1)
                    }
                    suffix.endsWith("/upload") && conflict -> throw ByoException("http",409)
                    suffix.endsWith("/upload") && expired -> throw ByoException("expired",409)
                    suffix.endsWith("/prepare") || suffix.endsWith("/upload") -> JSONObject().put("authorization",auth).put("status",status()).apply {
                        if(!committed && suffix.endsWith("/upload")) put("upload",JSONObject().put("method","PUT"))
                    }
                    suffix.endsWith("/complete") -> {committed=true;if(loseCompletion) {loseCompletion=false;throw ByoException("network")};status()}
                    suffix=="/"+this@Fixture.context.getString("upload_session_id") -> status()
                    else -> error("Unexpected request")
                }
            }
            override suspend fun put(instructions: JSONObject,file: File) {assertArrayEquals(bytes,file.readBytes());calls+="PUT"}
        }
        val ble=object: ByoDeviceLink {
            override suspend fun call(operation: Int,document: ByteArray): ByteArray {
                calls+="ble:$operation"
                return when(operation) {
                    1 -> "{\"contract\":\"bota-byo-device-batch-v1\",\"signing_key_ids\":[1],\"max_ciphertext_bytes\":134217728}".toByteArray()
                    2 -> if(removed) "{\"missing\":true}".toByteArray() else JSONObject().put("recording_uuid",recording.uuid).put("recording_generation",9).put("ciphertext_length",bytes.size).put("ciphertext_sha256",hash).toString().toByteArray()
                    3 -> "{\"manifest\":{\"opaque\":\"same-original-manifest\"}}".toByteArray()
                    4 -> {val input=java.nio.ByteBuffer.wrap(document).order(java.nio.ByteOrder.LITTLE_ENDIAN);val offset=input.long.toInt();val count=input.short.toInt() and 65535;bytes.copyOfRange(offset,offset+count)}
                    5 -> {if(rejectReceipt) throw ByoException("device_rejected");ByteArray(32){0x42}}
                    6 -> {check(committed);removed=true;if(loseConfirm){loseConfirm=false;throw ByoException("network")};byteArrayOf()}
                    else -> error("Unexpected RPC")
                }
            }
        }
        suspend fun run()=ByoUploadSession(options,recording,ble,http,{calls+="refresh"}).use {it.run()}
        fun cleanup() {root.deleteRecursively()}
    }
    @Test fun wholeFileRequiresDeviceReceiptBeforeConfirm()=runBlocking {
        val f=Fixture();try {
            assertEquals("rec_test",f.run().recordingId)
            assertEquals(1,f.calls.count {it=="PUT"})
            assertTrue(f.calls.indexOf("ble:5")<f.calls.indexOf("ble:6"))
        } finally {f.cleanup()}
    }
    @Test fun lostCompletionResumesReceiptWithoutAnotherPut()=runBlocking {
        val f=Fixture();try {
            f.loseCompletion=true
            try {f.run();fail("Expected uncertain completion")} catch(_: ByoException) {}
            assertFalse(f.calls.contains("ble:6"))
            assertEquals("rec_test",f.run().recordingId)
            assertEquals(1,f.calls.count {it=="PUT"})
        } finally {f.cleanup()}
    }
    @Test fun rejectedReceiptRetainsSourceAndNeverConfirms()=runBlocking {
        val f=Fixture();try {
            f.rejectReceipt=true
            try {f.run();fail("Expected rejected receipt")} catch(_: ByoException) {}
            assertFalse(f.calls.contains("ble:6"))
        } finally {f.cleanup()}
    }
    @Test fun lostConfirmUsesFreshAbsenceAndHistoricalReceipt()=runBlocking {
        val f=Fixture();try {
            f.loseConfirm=true
            try {f.run();fail("Expected uncertain CONFIRM")} catch(_: ByoException) {}
            assertTrue(f.removed)
            assertEquals("rec_test",f.run().recordingId)
            assertEquals(1,f.calls.count {it=="PUT"})
            assertEquals(1,f.calls.count {it=="ble:6"})
            assertEquals("rec_test",f.run().recordingId)
        } finally {f.cleanup()}
    }
    @Test fun realTypedBleAbiRoundTrip() {
        ByoBLECodec().use {codec ->
            val frame=codec.decode(codec.encode(112,2,3,0,20,byoIdentity("00112233-4455-6677-8899-aabbccddeeff",1u),244))
            assertEquals(3L,frame.id);assertEquals(20,frame.total);assertEquals(2,frame.operation)
        }
    }
    @Test fun uncertainRenewalReplaysDurableOperationAfterRestart()=runBlocking {
        val f=Fixture();try {
            f.expired=true;f.loseRenewal=true
            try {f.run();fail("Expected uncertain renewal")} catch(_: ByoException) {}
            assertFalse(f.calls.contains("PUT"))
            assertEquals("rec_test",f.run().recordingId)
            assertEquals(2,f.renewals.size)
            assertTrue(JSONObject(f.renewals[0]).byoEquivalent(JSONObject(f.renewals[1])))
            assertEquals(1,f.calls.count {it=="PUT"})
        } finally {f.cleanup()}
    }
    @Test fun uncertainCreateReplaysIdentityAndPreservesSelectionBeforeNetwork()=runBlocking {
        val f=Fixture();try {
            f.loseCreate=true
            try {f.run();fail("Expected uncertain create")} catch(_: ByoException) {}
            assertEquals("rec_test",f.run().recordingId)
            assertEquals(2,f.createBodies.size)
            assertTrue(JSONObject(f.createBodies[0]).byoEquivalent(JSONObject(f.createBodies[1])))
            assertTrue(f.calls.indexOf("ble:2")<f.calls.indexOf("http:"))
            assertEquals(1,f.calls.count {it=="PUT"})
        } finally {f.cleanup()}
    }
    @Test fun conflictCannotBeTreatedAsExpiredAuthorization()=runBlocking {
        val f=Fixture();try {
            f.conflict=true
            try {f.run();fail("Expected conflict")} catch(_: ByoException) {}
            assertTrue(f.renewals.isEmpty())
            assertFalse(f.calls.contains("PUT"))
            assertFalse(f.calls.contains("ble:6"))
        } finally {f.cleanup()}
    }
    @Test fun retryAfterNeverRetriesEarlyOrWaitsWithoutBound() {
        assertEquals(5000L,byoRetryDelay("5",2000L,0L))
        assertEquals(5000L,byoRetryDelay("Thu, 01 Jan 1970 00:00:05 GMT",2000L,0L))
        assertEquals(2000L,byoRetryDelay(null,2000L,0L))
        assertNull(byoRetryDelay("3600",2000L,0L))
    }
    private class LiveFixture(val initialWSFailure: Boolean=false,val establishedFailure: Boolean=false) {
        val batch=Fixture(20000);var closed=false;var acknowledged=0;var connections=0;var sent=0
        var holdCapture=false;var allowed=listOf("whole_file","http_segments","ws_relay");var selected=false;var savedContext=false;var handedOff=false;var loseHandoff=false;var mode=""
        val segments=mutableListOf<JSONObject>();val wsBytes=mutableListOf<ByteArray>()
        val context=JSONObject(batch.context.toString()).put("upload_session_id","11111111-1111-4111-8111-111111111111")
        val link=object: ByoDeviceLink {
            override suspend fun call(operation: Int,document: ByteArray): ByteArray = when(operation) {
                1 -> JSONObject(batch.ble.call(1,document).decodeToString()).put("upload_modes",org.json.JSONArray(listOf("whole_file","http_segments","ws_relay"))).toString().toByteArray()
                9 -> {if(document.size==21) selected=true
                    JSONObject().put("recording_uuid",batch.recording.uuid).put("recording_generation",9)
                        .put("ciphertext_length",if(closed) 20000 else 16384).put("closed",closed).put("failed",false)
                        .put("ciphertext_sha256",batch.hash).put("overflow",false).put("retained_offset",acknowledged)
                        .put("stream_selected",selected).apply {if(savedContext) put("stream_context",context)}.toString().toByteArray()}
                10 -> {check(selected&&savedContext);val p=java.nio.ByteBuffer.wrap(document,20,6).order(java.nio.ByteOrder.LITTLE_ENDIAN)
                    val offset=p.int;val count=p.short.toInt() and 65535;batch.bytes.copyOfRange(offset,offset+count)}
                11 -> {acknowledged=java.nio.ByteBuffer.wrap(document,20,4).order(java.nio.ByteOrder.LITTLE_ENDIAN).int;byteArrayOf()}
                12 -> {check(selected);savedContext=true;byteArrayOf()}
                13 -> {check(handedOff);byteArrayOf()}
                else -> batch.ble.call(operation,document)
            }
        }
        fun status()=JSONObject().put("phase",if(handedOff) "handed_off" else "receiving").put("recovery_required",false)
            .apply {if(handedOff) put("successor",batch.context).put("handoff_mode",mode)}
        val http=object: ByoControlClient {
            override suspend fun control(suffix: String,body: JSONObject?,context: Boolean)=batch.http.control(suffix,body,context).also {
                if(suffix=="/capabilities") it.put("upload_modes",org.json.JSONArray(allowed))
            }
            override suspend fun put(instructions: JSONObject,file: File) {
                if(instructions.optBoolean("segment")) {val offset=instructions.getInt("offset");val size=instructions.getInt("length");assertArrayEquals(batch.bytes.copyOfRange(offset,offset+size),file.readBytes());closed=true}
                else batch.http.put(instructions,file)
            }
            override suspend fun streamControl(suffix: String,body: JSONObject?): JSONObject=when {
                suffix=="" -> {check(selected);JSONObject().put("context",context)}
                suffix.endsWith("/grants") -> {segments+=JSONObject(requireNotNull(body).toString());JSONObject().put("result",JSONObject().put("state","write_authorized").put("segment",body).put("grant",JSONObject().put("segment",true).put("offset",body.getInt("offset")).put("length",body.getInt("length"))))}
                suffix.endsWith("/confirm") -> JSONObject().put("result",JSONObject().put("state","confirmed").put("segment",body))
                suffix.endsWith("/handoff") -> {val input=requireNotNull(body);if(handedOff) assertEquals(mode,input.getString("mode"));mode=input.getString("mode");handedOff=true
                    assertEquals(batch.hash,input.getJSONObject("final").getString("ciphertext_sha256"))
                    if(loseHandoff){loseHandoff=false;throw ByoException("network")};status()}
                else -> status()
            }
            override suspend fun streamSocket(session: String): ByoStreamSocket {
                connections++;if(initialWSFailure) throw ByoException("network")
                return object: ByoStreamSocket {
                    override suspend fun exchange(segment: JSONObject,bytes: ByteArray): JSONObject {
                        assertTrue(!closed || sent>0);if(!holdCapture) closed=true;sent++;segments+=JSONObject(segment.toString());wsBytes+=bytes.copyOf()
                        if(establishedFailure) throw ByoException("network")
                        return JSONObject()
                    }
                    override fun close() {}
                }
            }
        }
        suspend fun run()=ByoStreamSession(batch.options,batch.recording,link,http,{}).use {it.run()}
    }
    @Test fun liveWSReachesBatchReceiptWithoutWholeFilePut()=runBlocking {
        val f=LiveFixture();try {
            assertEquals("rec_test",f.run().recordingId);assertEquals("assembled",f.mode)
            assertEquals(2,f.sent);assertEquals(20000,f.acknowledged);assertEquals(0,f.batch.calls.count {it=="PUT"})
            assertTrue(f.batch.removed)
        } finally {f.batch.cleanup()}
    }
    @Test fun liveWSThreeReconnectsThenFullFileSuccessor()=runBlocking {
        val f=LiveFixture(establishedFailure=true);try {
            assertEquals("rec_test",f.run().recordingId);assertEquals(4,f.connections);assertEquals("whole_file",f.mode)
            assertEquals(0,f.acknowledged);assertEquals(1,f.batch.calls.count {it=="PUT"})
            assertTrue(f.wsBytes.all {it.contentEquals(f.wsBytes[0])});assertTrue(f.batch.removed)
        } finally {f.batch.cleanup()}
    }
    @Test fun lostLiveHandoffRecoversExactAssembledSuccessor()=runBlocking {
        val f=LiveFixture();try {
            f.loseHandoff=true
            try {f.run();fail("Expected uncertain handoff")} catch(_: ByoException) {}
            assertFalse(f.batch.removed);assertEquals("rec_test",f.run().recordingId)
            assertEquals("assembled",f.mode);assertEquals(0,f.batch.calls.count {it=="PUT"});assertEquals(1,f.connections)
        } finally {f.batch.cleanup()}
    }

    @Test fun initiallyUnavailableWSUsesHTTPForEntireRecording()=runBlocking {
        val f=LiveFixture(initialWSFailure=true);try {
            assertEquals("rec_test",f.run().recordingId);assertEquals(1,f.connections);assertEquals(0,f.sent)
            assertEquals("assembled",f.mode);assertEquals(0,f.batch.calls.count {it=="PUT"});assertTrue(f.batch.removed)
        } finally {f.batch.cleanup()}
    }
    @Test fun lostLiveBatchConfirmRestartsWithoutReadingDeletedSource()=runBlocking {
        val f=LiveFixture();try {
            f.batch.loseConfirm=true
            try {f.run();fail("Expected uncertain confirm")} catch(_: ByoException) {}
            assertTrue(f.batch.removed);assertEquals("rec_test",f.run().recordingId)
            assertEquals(0,f.batch.calls.count {it=="PUT"});assertEquals(1,f.connections)
        } finally {f.batch.cleanup()}
    }

    @Test fun liveStopIsAllowedButOtherOperationsRemainExclusive() {
        val owner=dev.bota.sdk.internal.DeviceOperationCoordinator();val live=java.util.UUID.randomUUID();val stop=java.util.UUID.randomUUID()
        owner.begin(live,BotaOperation.TransferRecording,allowRecordingControl=true)
        owner.begin(stop,BotaOperation.Encode,recordingControl=true)
        try {owner.begin(java.util.UUID.randomUUID(),BotaOperation.Encode);fail("Provisioning must remain exclusive")} catch(_: BotaSDKError) {}
        owner.end(live)
        try {owner.begin(java.util.UUID.randomUUID(),BotaOperation.TransferRecording);fail("Stop still owns the device")} catch(_: BotaSDKError) {}
        owner.end(stop);owner.begin(java.util.UUID.randomUUID(),BotaOperation.TransferRecording)
    }
    @Test fun typedLiveOperationsUseIndependentV3Codec() {
        ByoBLECodec().use {codec ->
            for(operation in 9..13) {
                val decoded=codec.decode(codec.encode(112,operation,3,0,20,byoIdentity("00112233-4455-6677-8899-aabbccddeeff",1u),244))
                assertEquals(operation,decoded.operation)
            }
        }
    }

    @Test fun liveCancellationRetainsSourceAndRestartsAtWholeFile()=runBlocking {
        val f=LiveFixture();try {
            f.holdCapture=true
            try {kotlinx.coroutines.withTimeout(300) {f.run()};fail("Expected cancellation")} catch(_: kotlinx.coroutines.TimeoutCancellationException) {}
            assertFalse(f.batch.removed);assertFalse(f.handedOff);assertTrue(f.selected)
            f.closed=true;assertEquals("rec_test",f.run().recordingId)
            assertEquals("whole_file",f.mode);assertEquals(1,f.connections);assertEquals(1,f.batch.calls.count {it=="PUT"})
        } finally {f.batch.cleanup()}
    }
    @Test fun wholeFileOnlyDestinationNeverPinsAnUnusableStream()=runBlocking {
        val f=LiveFixture();try {
            f.allowed=listOf("whole_file")
            try {f.run();fail("Expected unsupported stream")} catch(error: ByoException) {assertEquals("unsupported",error.reason)}
            assertFalse(f.selected);assertFalse(f.savedContext);assertEquals(0,f.connections);assertFalse(f.batch.removed)
        } finally {f.batch.cleanup()}
    }

}
