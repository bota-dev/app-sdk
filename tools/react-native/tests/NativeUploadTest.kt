package dev.bota.sdk.reactnative.upload

import dev.bota.sdk.EncryptedUploadV2TransferEvidence
import dev.bota.sdk.EncryptedUploadV2Capabilities
import dev.bota.sdk.EncryptedUploadV2CapabilitySnapshot
import dev.bota.sdk.EncryptedUploadV2ProviderContext
import dev.bota.sdk.EncryptedUploadV2Recording
import dev.bota.sdk.reactnative.BotaDeviceSDKEncryptedUploadV2Materials
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.nio.file.Files
import java.time.Instant
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test

class NativeUploadTest {
  @org.junit.Rule @JvmField val timeout = org.junit.rules.Timeout.seconds(30)
  private val recordingUuid = "10000000-0000-0000-0000-000000000001"
  private val sessionId = "20000000-0000-0000-0000-000000000001"
  private val ciphertextHash = "ab".repeat(32)
  private val authorization = ByteArray(408) { 7 }
  private val manifest = ByteArray(580) { 8 }
  private val receipt = ByteArray(336) { 9 }
  private val now = Instant.parse("2026-09-24T12:00:00Z").toEpochMilli()

  private fun input(operation: String = "operation-a", account: String = "account-a"): JSONObject {
    val scopeKey = "[\"https://api.example.test\",\"$account\",\"production\",\"eu_a\"]"
    return JSONObject().put("operationId", operation).put("journalKey", "01".repeat(32))
      .put("scope", JSONObject().put("apiOrigin", "https://api.example.test").put("accountId", account)
        .put("projectId", "project_a").put("organizationId", "org_a").put("environment", "production").put("endUserId", "eu_a")
        .put("deviceId", "dev_a").put("bindingGeneration", 1).put("serialNumber", "BOTA123")
        .put("nativeDeviceId", "AA:BB:CC:DD:EE:FF").put("scopeKey", scopeKey))
      .put("recording", JSONObject().put("uuid", recordingUuid).put("generation", 1)
        .put("ciphertextLength", "1024").put("ciphertextSha256", ciphertextHash)
        .put("startedAtMs", "$now").put("durationMs", "1000").put("plaintextLength", "900").put("storageFormat", 3))
      .put("capability", JSONObject().put("rawValueHex", "00".repeat(24)).put("flags", 0x37f)).apply {
        put("journalKey", digest(JSONArray(listOf(scopeKey, "dev_a", 1, recordingUuid, 1, "1024", ciphertextHash)).toString().toByteArray()))
      }
  }

  private fun session(state: String? = null, id: String = sessionId, revision: Int = 1) = JSONObject()
    .put("profile", "encrypted_upload_v2").put("session_id", id).put("owner_revision", revision)
    .put("policy", "v2_required").put("authorization_base64", Base64.getEncoder().encodeToString(authorization))
    .put("authorization_sha256", digest(authorization)).put("expires_at", "2026-09-24T12:15:00Z")
    .apply {
      if (state != null) put("state", state).put("channel", "ble").put("ciphertext_length", 1024)
        .put("ciphertext_sha256", ciphertextHash).put("plaintext_length", 900)
        .put("completion_receipt_base64", Base64.getEncoder().encodeToString(receipt))
        .put("completion_receipt_sha256", digest(receipt))
    }

  private fun evidence() = EncryptedUploadV2TransferEvidence(1024u, hex(ciphertextHash), 580u, hex(digest(manifest)), 1u)

  private fun providerContext(readNonce: suspend () -> ByteArray) = EncryptedUploadV2ProviderContext(
    EncryptedUploadV2Recording(recordingUuid, 1u, 1024u, hex(ciphertextHash)),
    EncryptedUploadV2CapabilitySnapshot(ByteArray(24), ByteArray(32),
      EncryptedUploadV2Capabilities(0x37fu, 580u, 580u, 128u, 8u, 1u, 8u)), null, readNonce)

  private fun resumed(operation: String = "operation-a") = input(operation).put("priorJournalEntry", JSONObject()
    .put("recordingId", "rec_a").put("sessionId", sessionId).put("ownerRevision", 1))

  private fun checkpoint(id: String = sessionId, owner: Int = 1) = JSONObject()
    .put("version", 1).put("uploadSessionId", id).put("ownerRevision", owner).put("revision", 1).put("nextCiphertextOffset", "512")
    .put("prefixSha256", "00".repeat(32)).put("transportSessionId", "18446744073709551615")
    .put("sinkRegistrationId", "native-sink").put("windowPackets", 8).put("dataPayloadBytes", 128)

  private fun context(state: String = "pending", id: String = sessionId) = JSONObject()
    .put("context_id", id).put("state", state).put("expires_at", "2026-09-24T12:01:00Z")
    .put("challenge_base64", encoded(ByteArray(196) { 5 }))
    .put("result_base64", if (state == "complete") encoded(ByteArray(264) { 6 }) else JSONObject.NULL)

  private class Harness(val directory: File) {
    val requests = mutableListOf<UploadRequest>()
    var response: suspend (UploadRequest) -> JSONObject = { error("Unexpected request") }
    var credentialCount = 0
    val broker = CredentialBroker { _, _ -> }
    val journal = UploadJournal(directory)
    val http = object : UploadHttp {
      override suspend fun execute(request: UploadRequest, operation: UploadOperation, retain: Boolean, beforeDispatch: () -> Unit): JSONObject {
        operation.active { beforeDispatch(); requests.add(request) }
        return response(request)
      }
    }
    fun adapter(now: Long, nonceByte: Byte = 3) = NativeUpload(journal, http, { operation ->
      operation.check(); credentialCount++; "credential-$credentialCount"
    }, { ByteArray(16) { nonceByte } }, { now }, { _, operation -> operation.check() })
  }

  private fun harness() = Harness(Files.createTempDirectory("bota-upload-test-").toFile())
  private suspend fun expectFailure(code: String, block: suspend () -> Unit) {
    try { block(); fail("Expected $code") } catch (error: UploadFailure) { assertEquals(code, error.code) }
  }

  @Test fun initialSessionHasOnlyMetadataAndFreshCredentials() = runBlocking {
    val h = harness()
    try {
      h.response = { if (it.path.endsWith("/recordings")) JSONObject().put("id", "rec_a") else session() }
      val adapter = h.adapter(now)
      val result = adapter.prepare(input().toString())
      assertEquals(setOf("profile", "uploadSessionId", "ownerRevision", "securityPolicy", "materialRegistrationId", "recordingId"), result.keys)
      assertEquals("rec_a", result["recordingId"])
      assertEquals(2, h.credentialCount)
      assertTrue(h.requests.all { it.headers["X-Organization-Id"] == "org_a" })
      assertTrue(h.requests.all { it.path.startsWith("/v1/") })
      assertEquals("eu_a", h.requests.first().body!!.getString("end_user_id"))
      assertEquals(listOf("Bearer credential-1", "Bearer credential-2"), h.requests.map { it.headers["Authorization"] })
      val stored = h.directory.listFiles()!!.single { it.extension == "json" }.readText()
      assertFalse(stored.contains("credential-"))
      assertFalse(stored.contains("authorization_base64"))
      assertEquals(digest(ByteArray(16) { 3 }), JSONObject(stored).getString("authorizationNonceSha256"))
      assertFalse(stored.contains("staging"))
      assertFalse(stored.contains("account-a"))
      assertTrue(stored.contains("identitySha256"))
      adapter.cancel("operation-a")
      assertNull(BotaDeviceSDKEncryptedUploadV2Materials.remove(result["materialRegistrationId"] as String))
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun reconnectWithNewBluetoothAddressResumesSameRecordingAndSession() = runBlocking {
    val h = harness()
    try {
      h.response = { if (it.path.endsWith("/recordings")) JSONObject().put("id", "rec_a") else session("staging") }
      val first = h.adapter(now)
      first.prepare(input().toString())
      first.cancel("operation-a")
      val reconnected = input("reconnected").apply { getJSONObject("scope").put("nativeDeviceId", "11:22:33:44:55:66") }
      val resumed = h.adapter(now)
      val result = resumed.prepare(reconnected.toString())
      assertEquals("rec_a", result["recordingId"])
      assertEquals(sessionId, result["uploadSessionId"])
      assertEquals(3, h.requests.size)
      assertEquals("GET", h.requests.last().method)
      assertEquals(1, h.requests.count { it.path.endsWith("/recordings") })
      resumed.cancel("reconnected")
      for ((section, field, value) in listOf(
        Triple("scope", "accountId", "account-b"), Triple("scope", "projectId", "project_b"),
        Triple("scope", "organizationId", "org_b"),
        Triple("scope", "environment", "development"), Triple("scope", "endUserId", "eu_b"),
        Triple("scope", "apiOrigin", "https://other.example.test"), Triple("scope", "serialNumber", "BOTA999"),
        Triple("scope", "bindingGeneration", 2), Triple("recording", "durationMs", "2000"),
        Triple("recording", "plaintextLength", "901"), Triple("recording", "ciphertextSha256", "cd".repeat(32)),
      )) {
        val changed = JSONObject(reconnected.toString()).apply { getJSONObject(section).put(field, value) }
        expectFailure("BOTA_UPLOAD_IDENTITY_CONFLICT") { h.adapter(now).prepare(changed.toString()) }
      }
      assertEquals(3, h.requests.size)
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun changedNonceRecoversUnexpiredSessionAndPersistsSuccessorBeforeRestart() = runBlocking {
    val h = harness()
    try {
      val child = "30000000-0000-0000-0000-000000000001"
      h.response = { if (it.path.endsWith("/recordings")) JSONObject().put("id", "rec_a") else session("staging") }
      val first = h.adapter(now)
      first.prepare(input().toString())
      first.cancel("operation-a")
      h.response = {
        when {
          it.path.endsWith("/recover") -> {
            assertEquals("nonce_changed", it.body!!.getString("reason"))
            assertEquals(encoded(ByteArray(16) { 4 }), it.body!!.getString("auth_nonce_base64"))
            assertEquals(1, it.body!!.getInt("owner_revision"))
            session("staging", child, 2)
          }
          it.path.endsWith(child) -> session("staging", child, 2)
          else -> session("staging")
        }
      }
      val next = h.adapter(now, 4)
      val selected = next.prepare(input("next").toString())
      assertEquals("rec_a", selected["recordingId"])
      assertEquals(child, selected["uploadSessionId"])
      val saved = h.journal.load(UploadInput.parse(input().toString()))!!
      assertEquals(UploadPointer("rec_a", child, 2), saved.pointer)
      assertEquals(digest(ByteArray(16) { 4 }), saved.authorizationNonceSha256)
      next.cancel("next")
      val restarted = h.adapter(now, 4)
      restarted.prepare(input("restart").toString())
      restarted.cancel("restart")
      assertEquals(1, h.requests.count { it.path.endsWith("/recover") })
      assertEquals(1, h.requests.count { it.path.endsWith("/sessions") && it.method == "POST" })
      assertEquals(1, h.requests.count { it.path.endsWith("/recordings") })
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun nonceRecoveryRefusalPreservesParentAndNeverCreatesAnotherRecording() = runBlocking {
    val h = harness()
    try {
      val parsed = UploadInput.parse(input().toString())
      val parent = JournalEntry(parsed.identitySha256, UploadPointer("rec_a", sessionId, 1),
        authorizationNonceSha256 = digest(ByteArray(16) { 3 }))
      h.journal.save(parsed, parent)
      h.response = { if (it.path.endsWith("/recover")) throw UploadFailure("BOTA_UPLOAD_HTTP_409") else session("staging") }
      expectFailure("BOTA_UPLOAD_HTTP_409") { h.adapter(now, 4).prepare(input().toString()) }
      assertEquals(parent.copy(recoveryNonceBase64 = encoded(ByteArray(16) { 4 })), h.journal.load(parsed))
      assertEquals(2, h.requests.size)
      assertTrue(h.requests.none { it.path.endsWith("/recordings") || it.path.endsWith("/sessions") })
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun nonceRecoveryDoesNotReplacePostManifestOrLegacySessionsWithoutNonceEvidence() = runBlocking {
    for (state in listOf("ready", "processing", "published", "staging")) {
      val h = harness()
      try {
        val parsed = UploadInput.parse(input().toString())
        h.journal.save(parsed, JournalEntry(parsed.identitySha256, UploadPointer("rec_a", sessionId, 1),
          authorizationNonceSha256 = if (state == "staging") null else digest(ByteArray(16) { 3 })))
        h.response = { session(state) }
        val adapter = h.adapter(now, 4)
        adapter.prepare(input().toString())
        adapter.cancel("operation-a")
        assertEquals(1, h.requests.size)
        assertEquals("GET", h.requests.single().method)
      } finally { h.directory.deleteRecursively() }
    }
  }

  @Test fun lostRecoveryResponseRetriesOriginalNonceThenReplacesStaleChild() = runBlocking {
    val h = harness()
    try {
      val parsed = UploadInput.parse(input().toString())
      val child = "30000000-0000-0000-0000-000000000001"
      val latest = "40000000-0000-0000-0000-000000000001"
      h.journal.save(parsed, JournalEntry(parsed.identitySha256, UploadPointer("rec_a", sessionId, 1),
        authorizationNonceSha256 = digest(ByteArray(16) { 3 })))
      h.response = { if (it.path.endsWith("/recover")) throw UploadFailure("BOTA_UPLOAD_TRANSPORT") else session("staging") }
      expectFailure("BOTA_UPLOAD_TRANSPORT") { h.adapter(now, 4).prepare(input().toString()) }
      assertEquals(encoded(ByteArray(16) { 4 }), h.journal.load(parsed)!!.recoveryNonceBase64)
      h.response = {
        when {
          it.path.endsWith("/$sessionId/recover") -> {
            assertEquals(encoded(ByteArray(16) { 4 }), it.body!!.getString("auth_nonce_base64"))
            session("staging", child, 2)
          }
          it.path.endsWith("/$child/recover") -> {
            assertEquals(encoded(ByteArray(16) { 5 }), it.body!!.getString("auth_nonce_base64"))
            session("staging", latest, 3)
          }
          it.path.endsWith(latest) -> session("staging", latest, 3)
          it.path.endsWith(child) -> session("staging", child, 2)
          else -> session("cancelled")
        }
      }
      val adapter = h.adapter(now, 5)
      val selected = adapter.prepare(input("restart").toString())
      assertEquals(latest, selected["uploadSessionId"])
      assertEquals("rec_a", selected["recordingId"])
      assertEquals(digest(ByteArray(16) { 5 }), h.journal.load(parsed)!!.authorizationNonceSha256)
      assertNull(h.journal.load(parsed)!!.recoveryNonceBase64)
      assertTrue(h.requests.none { it.path.endsWith("/recordings") || it.path.endsWith("/sessions") })
      adapter.cancel("restart")
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun invalidNonceHashInJournalFailsBeforeNetwork() = runBlocking {
    val h = harness()
    try {
      val parsed = UploadInput.parse(input().toString())
      val file = File(h.directory, "${parsed.journalKey}.json")
      for (bad in listOf("", "ab", "z".repeat(64))) {
        file.writeText(JournalEntry(parsed.identitySha256, UploadPointer("rec_a", sessionId, 1),
          authorizationNonceSha256 = bad).json().toString())
        expectFailure("BOTA_UPLOAD_INVALID_INPUT") { h.adapter(now).prepare(input().toString()) }
      }
      assertTrue(h.requests.isEmpty())
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun legacyJournalMigrationPreservesPointerAndUnknownOutcomes() = runBlocking {
    for (phase in listOf("ready", "recording_create_unknown", "session_create_unknown")) {
      val h = harness()
      try {
        val parsed = UploadInput.parse(input().toString())
        val pointer = if (phase == "recording_create_unknown") null else UploadPointer("rec_a")
        val legacy = JournalEntry(parsed.legacyIdentitySha256, pointer, phase, "12".repeat(32))
          .json().put("version", 1).toString()
        val file = File(h.directory, "${parsed.journalKey}.json")
        file.writeText(legacy)
        val rotated = input("rotated").apply { getJSONObject("scope").put("nativeDeviceId", "11:22:33:44:55:66") }
        expectFailure("BOTA_UPLOAD_IDENTITY_CONFLICT") { h.adapter(now).prepare(rotated.toString()) }
        assertEquals(legacy, file.readText())
        assertEquals(JournalEntry(parsed.identitySha256, pointer, phase, "12".repeat(32)), h.journal.load(parsed))
        assertEquals(2, JSONObject(file.readText()).getInt("version"))
        assertEquals(h.journal.load(parsed), h.journal.load(UploadInput.parse(rotated.toString())))
        if (phase != "ready") {
          expectFailure("BOTA_UPLOAD_UNKNOWN_OUTCOME") { h.adapter(now).prepare(rotated.toString()) }
        }
        assertTrue(h.requests.isEmpty())
      } finally { h.directory.deleteRecursively() }
    }
  }

  @Test fun legacyJournalMigrationMustBeDurableBeforeNetworkDispatch() = runBlocking {
    val h = harness()
    try {
      val parsed = UploadInput.parse(input().toString())
      val file = File(h.directory, "${parsed.journalKey}.json")
      val legacy = JournalEntry(parsed.legacyIdentitySha256, UploadPointer("rec_a")).json().put("version", 1).toString()
      file.writeText(legacy)
      val journal = UploadJournal(h.directory, object : JournalDurability {
        override fun syncFile(stream: FileOutputStream) { throw IOException("cannot fsync") }
      })
      val adapter = NativeUpload(journal, h.http, { "token" }, { ByteArray(16) }, { now })
      expectFailure("BOTA_UPLOAD_JOURNAL") { adapter.prepare(input().toString()) }
      assertEquals(legacy, file.readText())
      assertTrue(h.requests.isEmpty())
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun cancellationDrainsDispatchedCreateIntoOriginalJournalAndRejectsRestartRetarget() = runBlocking {
    val h = harness()
    try {
      val dispatched = CompletableDeferred<Unit>()
      val body = CompletableDeferred<JSONObject>()
      h.response = { dispatched.complete(Unit); body.await() }
      val adapter = h.adapter(now)
      val pending = async { runCatching { adapter.prepare(input().toString()) } }
      dispatched.await()
      adapter.cancel("operation-a")
      body.complete(JSONObject().put("id", "rec_a"))
      assertEquals("BOTA_UPLOAD_CANCELLED", (pending.await().exceptionOrNull() as UploadFailure).code)
      assertEquals(1, h.requests.size)
      assertTrue(h.directory.listFiles()!!.single { it.extension == "json" }.readText().contains("rec_a"))
      expectFailure("BOTA_UPLOAD_IDENTITY_CONFLICT") {
        h.adapter(now).prepare(input("operation-b").apply { getJSONObject("scope").put("projectId", "project_b") }.toString())
      }
      h.response = { session() }
      val restarted = h.adapter(now).prepare(input("operation-c").toString())
      assertEquals("rec_a", restarted["recordingId"])
      assertEquals(1, h.requests.count { it.path.endsWith("/recordings") })
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun unknownInitialOutcomeNeverCreatesAgainAfterRestart() = runBlocking {
    val h = harness()
    try {
      h.response = { throw UploadFailure("BOTA_UPLOAD_TRANSPORT") }
      expectFailure("BOTA_UPLOAD_TRANSPORT") { h.adapter(now).prepare(input().toString()) }
      expectFailure("BOTA_UPLOAD_UNKNOWN_OUTCOME") { h.adapter(now).prepare(input("operation-b").toString()) }
      assertEquals(1, h.requests.size)
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun recordingCreateAuthRejectionsPermitFreshAttempts() = runBlocking {
    for (status in listOf(401, 403)) {
      val h = harness()
      try {
        val adapter = h.adapter(now)
        h.response = { throw UploadFailure("BOTA_UPLOAD_HTTP_$status") }
        expectFailure("BOTA_UPLOAD_HTTP_$status") { adapter.prepare(input().toString()) }
        assertNull(h.journal.load(UploadInput.parse(input().toString())))
        h.response = { if (it.path.endsWith("/recordings")) JSONObject().put("id", "rec_a") else session() }
        assertEquals("rec_a", adapter.prepare(input("fresh").toString())["recordingId"])
        assertEquals(2, h.requests.count { it.path.endsWith("/recordings") })
        adapter.cancel("fresh")
      } finally { h.directory.deleteRecursively() }
    }
  }

  @Test fun sessionCreateAuthRejectionsRestoreImportedPointerAndPermitRestart() = runBlocking {
    for (status in listOf(401, 403)) {
      val h = harness()
      try {
        val request = input().put("priorJournalEntry", JSONObject().put("recordingId", "rec_a"))
        val parsed = UploadInput.parse(request.toString())
        val expected = JournalEntry(parsed.identitySha256, parsed.prior, importedPriorSha256 = parsed.prior!!.fingerprint())
        h.response = { throw UploadFailure("BOTA_UPLOAD_HTTP_$status") }
        expectFailure("BOTA_UPLOAD_HTTP_$status") { h.adapter(now).prepare(request.toString()) }
        assertEquals(expected, h.journal.load(parsed))
        h.response = { session() }
        val restarted = h.adapter(now)
        assertEquals(sessionId, restarted.prepare(request.put("operationId", "fresh").toString())["uploadSessionId"])
        assertEquals(expected.importedPriorSha256, h.journal.load(parsed)!!.importedPriorSha256)
        assertTrue(h.requests.all { it.path.endsWith("/sessions") })
        restarted.cancel("fresh")
      } finally { h.directory.deleteRecursively() }
    }
  }

  @Test fun ambiguousAndOtherCreateFailuresStayParkedEvenAfterCancellation() = runBlocking {
    for (sessionCreate in listOf(false, true)) for (cancelled in listOf(false, true)) {
      for (code in listOf("TRANSPORT", "INVALID_DOCUMENT", "HTTP_400", "HTTP_404", "HTTP_409", "HTTP_429", "HTTP_500", "HTTP_503")) {
        val h = harness()
        try {
          val request = input().apply {
            if (sessionCreate) put("priorJournalEntry", JSONObject().put("recordingId", "rec_a"))
          }
          val adapter = h.adapter(now)
          h.response = { if (cancelled) adapter.cancel("operation-a"); throw UploadFailure("BOTA_UPLOAD_$code") }
          assertTrue(runCatching { adapter.prepare(request.toString()) }.isFailure)
          val parsed = UploadInput.parse(request.toString())
          assertEquals(if (sessionCreate) "session_create_unknown" else "recording_create_unknown", h.journal.load(parsed)!!.phase)
          expectFailure("BOTA_UPLOAD_UNKNOWN_OUTCOME") { h.adapter(now).prepare(request.put("operationId", "fresh").toString()) }
          assertEquals(1, h.requests.size)
        } finally { h.directory.deleteRecursively() }
      }
    }
  }

  @Test fun cancelledAuthRejectionRollsBackOnlyAfterResponseWhileJournalLeaseIsHeld() = runBlocking {
    for (sessionCreate in listOf(false, true)) for (status in listOf(401, 403)) {
      val h = harness()
      try {
        val request = input().apply {
          if (sessionCreate) put("priorJournalEntry", JSONObject().put("recordingId", "rec_a"))
        }
        val dispatched = CompletableDeferred<Unit>()
        val response = CompletableDeferred<Unit>()
        val adapter = h.adapter(now)
        h.response = { dispatched.complete(Unit); response.await(); throw UploadFailure("BOTA_UPLOAD_HTTP_$status") }
        val pending = async { runCatching { adapter.prepare(request.toString()) } }
        dispatched.await()
        adapter.cancel("operation-a")
        val parsed = UploadInput.parse(request.toString())
        val marker = h.journal.load(parsed)!!
        assertTrue(marker.phase.endsWith("_unknown"))
        expectFailure("BOTA_UPLOAD_BUSY") { adapter.prepare(request.put("operationId", "competing").toString()) }
        assertEquals(marker, h.journal.load(parsed))
        response.complete(Unit)
        assertEquals("BOTA_UPLOAD_CANCELLED", (pending.await().exceptionOrNull() as UploadFailure).code)
        if (sessionCreate) assertEquals(marker.copy(phase = "ready"), h.journal.load(parsed))
        else assertNull(h.journal.load(parsed))
        h.response = { if (it.path.endsWith("/recordings")) JSONObject().put("id", "rec_a") else session() }
        assertEquals("rec_a", adapter.prepare(request.put("operationId", "fresh").toString())["recordingId"])
        adapter.cancel("fresh")
      } finally { h.directory.deleteRecursively() }
    }
  }

  @Test fun authRejectionNeverRollsBackChangedJournalIdentityOrMarker() = runBlocking {
    for (conflict in listOf("scope", "pointer", "phase", "import")) {
      val h = harness()
      try {
        val request = input().put("priorJournalEntry", JSONObject().put("recordingId", "rec_a"))
        val parsed = UploadInput.parse(request.toString())
        val owner = if (conflict == "scope") UploadInput.parse(JSONObject(request.toString()).apply {
          getJSONObject("scope").put("projectId", "project_b")
        }.toString()) else parsed
        var changed: JournalEntry? = null
        h.response = {
          changed = JournalEntry(owner.identitySha256,
            if (conflict == "pointer") UploadPointer("rec_a", sessionId, 2) else parsed.prior,
            if (conflict == "phase" || conflict == "pointer") "ready" else "session_create_unknown",
            if (conflict == "import") "12".repeat(32) else parsed.prior!!.fingerprint())
          h.journal.save(owner, changed!!)
          throw UploadFailure("BOTA_UPLOAD_HTTP_401")
        }
        expectFailure("BOTA_UPLOAD_IDENTITY_CONFLICT") { h.adapter(now).prepare(request.toString()) }
        assertEquals(changed, h.journal.load(owner))
        assertEquals(1, h.requests.size)
      } finally { h.directory.deleteRecursively() }
    }
  }

  @Test fun authFailureBeforeDispatchPreservesReadyJournal() = runBlocking {
    val h = harness()
    try {
      val parsed = UploadInput.parse(input().toString())
      val original = JournalEntry(parsed.identitySha256, UploadPointer("rec_a"), importedPriorSha256 = "12".repeat(32))
      h.journal.save(parsed, original)
      val adapter = NativeUpload(h.journal, h.http, { throw UploadFailure("BOTA_UPLOAD_HTTP_401") }, { ByteArray(16) })
      expectFailure("BOTA_UPLOAD_HTTP_401") { adapter.prepare(input().toString()) }
      assertEquals(original, h.journal.load(parsed))
      assertTrue(h.requests.isEmpty())
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun rejectedSessionRollbackFsyncFailureKeepsUnknownMarker() = runBlocking {
    val h = harness()
    try {
      val parsed = UploadInput.parse(input().toString())
      val original = JournalEntry(parsed.identitySha256, UploadPointer("rec_a"), importedPriorSha256 = "12".repeat(32))
      h.journal.save(parsed, original)
      var writes = 0
      val journal = UploadJournal(h.directory, object : JournalDurability {
        override fun syncFile(stream: FileOutputStream) {
          if (++writes == 2) throw IOException("rollback fsync failed")
          super.syncFile(stream)
        }
      })
      h.response = { throw UploadFailure("BOTA_UPLOAD_HTTP_403") }
      val adapter = NativeUpload(journal, h.http, { "token" }, { ByteArray(16) })
      expectFailure("BOTA_UPLOAD_JOURNAL") { adapter.prepare(input().toString()) }
      assertEquals(original.copy(phase = "session_create_unknown"), h.journal.load(parsed))
      expectFailure("BOTA_UPLOAD_UNKNOWN_OUTCOME") { h.adapter(now).prepare(input("fresh").toString()) }
      assertEquals(1, h.requests.size)
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun manifestReplayAllowsPutOnlyForExplicitMissingAndPersistsAcceptedIdentity() = runBlocking {
    val h = harness()
    try {
      h.response = { session("staging") }
      val adapter = h.adapter(now)
      val result = adapter.prepare(resumed().toString())
      val material = BotaDeviceSDKEncryptedUploadV2Materials.remove(result["materialRegistrationId"] as String)!!
      for (code in listOf("HTTP_403", "HTTP_409", "HTTP_503", "TRANSPORT")) {
        h.response = { throw UploadFailure("BOTA_UPLOAD_$code") }
        expectFailure("BOTA_UPLOAD_$code") { material.reconcileStaging!!(manifest, evidence()) }
      }
      h.response = { throw UploadFailure("BOTA_UPLOAD_STAGING_MISSING") }
      assertTrue(material.reconcileStaging!!(manifest, evidence()))
      h.response = { JSONObject() }
      assertFalse(material.reconcileStaging!!(manifest, evidence()))
      val count = h.requests.size
      material.submitManifest(manifest, evidence())
      assertEquals(count, h.requests.size)
      assertNotNull(h.journal.load(UploadInput.parse(input().toString())))
      adapter.cancel("operation-a")
      h.response = { session("processing") }
      val recovered = h.adapter(now).prepare(input("operation-b").toString())
      assertEquals("rec_a", recovered["recordingId"])
      assertEquals(sessionId, recovered["uploadSessionId"])
      assertEquals("GET", h.requests.last().method)
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun httpRequiresExactMissingErrorCodeAndStatusBeforeAnotherPut() = runBlocking {
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    var status = 409
    var body = "{\"error\":{\"code\":\"encrypted_upload_v2_staging_missing\"}}"
    server.createContext("/manifest") { exchange ->
      val bytes = body.toByteArray()
      exchange.sendResponseHeaders(status, bytes.size.toLong())
      exchange.responseBody.use { it.write(bytes) }
    }
    server.start()
    try {
      suspend fun request() = BackendUploadHttp().execute(UploadRequest("http://127.0.0.1:${server.address.port}",
        "/manifest", "POST", emptyMap(), JSONObject()), UploadOperation(UploadInput.parse(input().toString())), false)
      expectFailure("BOTA_UPLOAD_STAGING_MISSING") { request() }
      status = 403
      expectFailure("BOTA_UPLOAD_HTTP_403") { request() }
      status = 409; body = "{\"error\":{\"code\":\"resource_already_exists\"}}"
      expectFailure("BOTA_UPLOAD_HTTP_409") { request() }
    } finally { server.stop(0) }
  }

  @Test fun nativeKeyDerivationAndProxyPrefixKeepScopeAndNeverForwardOrgWhenAbsent() = runBlocking {
    val h = harness()
    try {
      val supplied = input()
      val expected = supplied.getString("journalKey")
      supplied.remove("journalKey")
      supplied.getJSONObject("scope").put("organizationId", "").put("apiBasePath", "/customer/upload")
      assertEquals(expected, UploadInput.parse(supplied.toString()).journalKey)
      h.response = { if (it.path.endsWith("/recordings")) JSONObject().put("id", "rec_a") else session() }
      h.adapter(now).prepare(supplied.toString())
      assertTrue(h.requests.all { it.path.startsWith("/customer/upload/") && "X-Organization-Id" !in it.headers })
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun stagedResumeSkipsPutButChecksManifestAndReceiptBeforeCleanup() = runBlocking {
    val h = harness()
    try {
      val request = input().put("priorJournalEntry", JSONObject().put("recordingId", "rec_a").put("sessionId", sessionId).put("ownerRevision", 1))
      h.response = { session("staged") }
      val adapter = h.adapter(now)
      val result = adapter.prepare(request.toString())
      val material = BotaDeviceSDKEncryptedUploadV2Materials.remove(result["materialRegistrationId"] as String)!!
      assertFalse(material.shouldUploadCiphertext(evidence()))
      expectFailure("BOTA_UPLOAD_NOT_COMPLETE") { adapter.complete("operation-a") }
      expectFailure("BOTA_UPLOAD_INVALID_DOCUMENT") { material.submitManifest(ByteArray(579), evidence()) }
      h.response = { if (it.path.endsWith("/manifest")) JSONObject() else session("published") }
      material.submitManifest(manifest, evidence())
      material.finalize(evidence())
      assertArrayEquals(receipt, material.completionReceipt(evidence()))
      assertTrue(h.directory.listFiles()!!.any { it.extension == "json" })
      adapter.complete("operation-a")
      assertFalse(h.directory.listFiles()!!.any { it.extension == "json" })
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun cancellationRejectsLateCredentialsAndNeverRetargetsAnOperation() = runBlocking {
    val h = harness()
    try {
      val requested = CompletableDeferred<String>()
      val broker = CredentialBroker { requestId, operationId ->
        assertEquals("operation-a", operationId)
        requested.complete(requestId)
      }
      val adapter = NativeUpload(h.journal, h.http, broker::request, { ByteArray(16) })
      val pending = async { runCatching { adapter.prepare(input().toString()) } }
      val requestId = requested.await()
      adapter.cancel("operation-a")
      broker.resolve(requestId, "new-account-token")
      val failure = pending.await().exceptionOrNull() as UploadFailure
      assertEquals("BOTA_UPLOAD_CANCELLED", failure.code)
      assertTrue(h.requests.isEmpty())
      expectFailure("BOTA_UPLOAD_BUSY") { adapter.prepare(input().toString()) }
      assertFalse(h.directory.listFiles()!!.any { it.extension == "json" })
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun cancellationOfSessionCreateDrainsOwnerBeforeRejecting() = runBlocking {
    val h = harness()
    try {
      val dispatched = CompletableDeferred<Unit>()
      val response = CompletableDeferred<JSONObject>()
      h.response = {
        if (it.path.endsWith("/recordings")) JSONObject().put("id", "rec_a")
        else { dispatched.complete(Unit); response.await() }
      }
      val adapter = h.adapter(now)
      val task = async { runCatching { adapter.prepare(input().toString()) } }
      dispatched.await()
      adapter.cancel("operation-a")
      response.complete(session())
      assertEquals("BOTA_UPLOAD_CANCELLED", (task.await().exceptionOrNull() as UploadFailure).code)
      val entry = h.journal.load(UploadInput.parse(input().toString()))!!
      assertEquals(UploadPointer("rec_a", sessionId, 1), entry.pointer)
      assertEquals("ready", entry.phase)
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun unknownSessionCreateBlocksRestartAndNeverRetriesPost() = runBlocking {
    val h = harness()
    try {
      h.response = { if (it.path.endsWith("/recordings")) JSONObject().put("id", "rec_a") else throw UploadFailure("BOTA_UPLOAD_TRANSPORT") }
      expectFailure("BOTA_UPLOAD_TRANSPORT") { h.adapter(now).prepare(input().toString()) }
      expectFailure("BOTA_UPLOAD_UNKNOWN_OUTCOME") { h.adapter(now).prepare(input("operation-b").toString()) }
      assertEquals(2, h.requests.size)
      assertEquals("session_create_unknown", h.journal.load(UploadInput.parse(input().toString()))!!.phase)
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun priorAndCheckpointConflictsFailBeforeAnyHttp() = runBlocking {
    val h = harness()
    try {
      val input = UploadInput.parse(resumed().toString())
      h.journal.save(input, JournalEntry(input.identitySha256, input.prior))
      val conflict = resumed().apply { getJSONObject("priorJournalEntry").put("recordingId", "rec_other") }
      expectFailure("BOTA_UPLOAD_IDENTITY_CONFLICT") { h.adapter(now).prepare(conflict.toString()) }
      val variants = listOf(checkpoint(owner = 2), checkpoint("30000000-0000-0000-0000-000000000001"),
        checkpoint().put("nextCiphertextOffset", "1025"), checkpoint().put("recordingUuid", "wrong"))
      variants.forEach { cp ->
        expectFailure("BOTA_UPLOAD_IDENTITY_CONFLICT") { h.adapter(now).prepare(resumed().put("checkpoint", cp).toString()) }
      }
      assertTrue(h.requests.isEmpty())
      h.response = { session("staged") }
      h.adapter(now).prepare(resumed().put("checkpoint", checkpoint()).toString())
      assertEquals(1, h.requests.size)
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun lowerCheckpointCanResumePersistedSuccessorWithoutGrantingReplacementInApp() = runBlocking {
    val h = harness()
    try {
      val successor = "30000000-0000-0000-0000-000000000001"
      val i = UploadInput.parse(input().toString())
      h.journal.save(i, JournalEntry(i.identitySha256, UploadPointer("rec_a", successor, 2)))
      h.response = { session("staging", successor, 2) }
      val decision = h.adapter(now).prepare(input().put("checkpoint", checkpoint()).toString())
      assertEquals(2L, decision["ownerRevision"])
      assertEquals(successor, decision["uploadSessionId"])
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun statusMatrixSkipsOnlyAlreadyStagedObjectsAndRejectsTerminalOrUnknownStates() = runBlocking {
    for (state in listOf("staging", "staged", "ready", "processing", "published", "created", "failed", "cancelled", "garbage")) {
      val h = harness()
      try {
        h.response = { session(state) }
        val adapter = h.adapter(now)
        if (state in setOf("created", "failed", "cancelled", "garbage")) {
          expectFailure("BOTA_UPLOAD_STATE") { adapter.prepare(resumed().toString()) }
        } else {
          val result = adapter.prepare(resumed().toString())
          val material = BotaDeviceSDKEncryptedUploadV2Materials.remove(result["materialRegistrationId"] as String)!!
          assertEquals(state == "staging", material.shouldUploadCiphertext(evidence()))
          h.requests.clear()
          material.submitManifest(manifest, evidence())
          assertEquals(if (state in setOf("staging", "staged")) 1 else 0, h.requests.size)
        }
      } finally { h.directory.deleteRecursively() }
    }
  }

  @Test fun stagingFetchesFreshUrlAndChecksSessionExpiryAfterCredentialAndHttpDelay() = runBlocking {
    val h = harness()
    try {
      var clock = now
      var targets = 0
      h.response = {
        if (it.path.endsWith("/staging-url")) JSONObject().put("method", "PUT")
          .put("url", "https://staging.example.test/object?signature=${++targets}")
          .put("headers", JSONObject().put("x-amz-checksum-sha256", "unchanged"))
        else session("staging")
      }
      val adapter = NativeUpload(h.journal, h.http, { "token" }, { ByteArray(16) }, { clock })
      val result = adapter.prepare(resumed().toString())
      val material = BotaDeviceSDKEncryptedUploadV2Materials.remove(result["materialRegistrationId"] as String)!!
      val first = material.stagingRequest(evidence())
      val second = material.stagingRequest(evidence())
      assertNotEquals(first.url, second.url)
      assertEquals("PUT", second.method)
      assertEquals(0L, second.body!!.contentLength())
      assertEquals("unchanged", second.header("x-amz-checksum-sha256"))
      assertNull(second.header("Authorization"))
      h.response = {
        clock += 16 * 60 * 1000
        JSONObject().put("method", "PUT").put("url", "https://staging.example.test/object").put("headers", JSONObject())
      }
      expectFailure("BOTA_UPLOAD_EXPIRED") { material.stagingRequest(evidence()) }
      val count = h.requests.size
      expectFailure("BOTA_UPLOAD_EXPIRED") { material.stagingRequest(evidence()) }
      assertEquals(count, h.requests.size)
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun signedReplacementTraversesAtMostThreeExpiredChildrenAndPersistsLastPointer() = runBlocking {
    val h = harness()
    try {
      var revision = 1
      var id = sessionId
      h.response = {
        if (it.path.endsWith("/recover")) {
          revision++
          id = "20000000-0000-0000-0000-${revision.toString().padStart(12, '0')}"
          JSONObject().put("profile", "encrypted_upload_v2").put("session_id", id).put("owner_revision", revision)
        } else session("expired", id, revision)
      }
      expectFailure("BOTA_UPLOAD_RECOVERY_LIMIT") { h.adapter(now).prepare(resumed().toString()) }
      assertEquals(3, h.requests.count { it.path.endsWith("/recover") })
      val entry = h.journal.load(UploadInput.parse(input().toString()))!!
      assertEquals(4L, entry.pointer!!.ownerRevision)
      assertEquals("rec_a", entry.pointer!!.recordingId)
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun recoveryRequiresCapabilityAndDoesNotReplacePostManifestForElapsedExpiry() = runBlocking {
    val h = harness()
    try {
      h.response = { session("expired") }
      expectFailure("BOTA_UPLOAD_EXPIRED") {
        h.adapter(now).prepare(resumed().apply { getJSONObject("capability").put("flags", 0x17f) }.toString())
      }
      assertEquals(1, h.requests.size)
      h.response = { session("published").put("expires_at", "2026-09-24T11:00:00Z") }
      val result = h.adapter(now).prepare(input("operation-b").toString())
      assertEquals(sessionId, result["uploadSessionId"])
      assertFalse(h.requests.any { it.path.endsWith("/recover") })
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun cancellationDrainsRecoveryPointerWithoutFetchingSuccessorStatus() = runBlocking {
    val h = harness()
    try {
      val dispatched = CompletableDeferred<Unit>()
      val response = CompletableDeferred<JSONObject>()
      h.response = { if (it.path.endsWith("/recover")) { dispatched.complete(Unit); response.await() } else session("expired") }
      val adapter = h.adapter(now)
      val task = async { runCatching { adapter.prepare(resumed().toString()) } }
      dispatched.await()
      adapter.cancel("operation-a")
      val successor = "30000000-0000-0000-0000-000000000001"
      response.complete(JSONObject().put("profile", "encrypted_upload_v2").put("session_id", successor).put("owner_revision", 2))
      assertEquals("BOTA_UPLOAD_CANCELLED", (task.await().exceptionOrNull() as UploadFailure).code)
      assertEquals(2, h.requests.size)
      assertEquals(successor, h.journal.load(UploadInput.parse(input().toString()))!!.pointer!!.sessionId)
      h.response = { session("staging", successor, 2) }
      val restarted = h.adapter(now).prepare(resumed("operation-b").toString())
      assertEquals(successor, restarted["uploadSessionId"])
      val conflict = resumed("operation-c").apply {
        getJSONObject("priorJournalEntry").put("sessionId", "40000000-0000-0000-0000-000000000001")
      }
      expectFailure("BOTA_UPLOAD_IDENTITY_CONFLICT") { h.adapter(now).prepare(conflict.toString()) }
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun contextRetriesIdenticalNonceAndProofWithFreshCredentialsAndValidatesLastPoll() = runBlocking {
    val h = harness()
    try {
      h.response = { session("staged") }
      val adapter = h.adapter(now)
      val result = adapter.prepare(resumed().toString())
      val material = BotaDeviceSDKEncryptedUploadV2Materials.remove(result["materialRegistrationId"] as String)!!
      var creates = 0
      var proofs = 0
      var polls = 0
      h.response = {
        when {
          it.path.endsWith("/contexts") -> if (++creates < 3) throw UploadFailure("BOTA_UPLOAD_HTTP_503") else context("challenge")
          it.path.endsWith("/proof") -> if (++proofs < 3) throw UploadFailure("BOTA_UPLOAD_TRANSPORT") else context()
          else -> { polls++; context(if (polls == 100) "complete" else "pending") }
        }
      }
      val nonce = ByteArray(16) { 42 }
      val exchange = material.uploadContext!!(nonce)
      val resultBytes = exchange.exchangeProof(ByteArray(116) { 4 })
      assertEquals(264, resultBytes.size)
      assertEquals(100, polls)
      assertEquals(3, creates)
      assertEquals(3, proofs)
      assertEquals(setOf(encoded(nonce)), h.requests.filter { it.path.endsWith("/contexts") }.map { it.body!!.getString("nonce_base64") }.toSet())
      assertEquals(1, h.requests.filter { it.path.endsWith("/proof") }.map { it.body!!.toString() }.toSet().size)
      assertEquals(h.requests.size, h.credentialCount)
      polls = 0
      h.response = {
        if (it.path.endsWith("/proof")) context()
        else { polls++; context(if (polls == 100) "complete" else "pending", if (polls == 100) recordingUuid else sessionId) }
      }
      expectFailure("BOTA_UPLOAD_IDENTITY_CONFLICT") { exchange.exchangeProof(ByteArray(116)) }
      assertEquals(100, polls)
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun malformedAuthorizationAndReceiptFailClosedAndPublishedDoesNotMeanComplete() = runBlocking {
    val h = harness()
    try {
      h.response = { session("staged").put("authorization_sha256", "00".repeat(32)) }
      expectFailure("BOTA_UPLOAD_INVALID_DOCUMENT") { h.adapter(now).prepare(resumed().toString()) }
      h.response = { session("published") }
      val adapter = h.adapter(now)
      val result = adapter.prepare(input("operation-b").toString())
      val material = BotaDeviceSDKEncryptedUploadV2Materials.remove(result["materialRegistrationId"] as String)!!
      h.response = { session("published").put("completion_receipt_base64", encoded(ByteArray(335))) }
      expectFailure("BOTA_UPLOAD_INVALID_DOCUMENT") { material.finalize(evidence()) }
      expectFailure("BOTA_UPLOAD_NOT_COMPLETE") { material.completionReceipt(evidence()) }
      expectFailure("BOTA_UPLOAD_NOT_COMPLETE") { adapter.complete("operation-b") }
      h.response = { session("published").put("plaintext_length", 901) }
      expectFailure("BOTA_UPLOAD_INVALID_DOCUMENT") { material.finalize(evidence()) }
      h.response = { session("published") }
      material.finalize(evidence())
      expectFailure("BOTA_UPLOAD_NOT_COMPLETE") { adapter.complete("operation-b") }
      material.completionReceipt(evidence())
      adapter.cancel("operation-b")
      expectFailure("BOTA_UPLOAD_NOT_COMPLETE") { adapter.complete("operation-b") }
      assertNotNull(h.journal.load(UploadInput.parse(input().toString())))
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun terminalPollingIsBoundedAnd403DoesNotTriggerRetryOrCredentialRetarget() = runBlocking {
    val h = harness()
    try {
      h.response = { session("processing") }
      val adapter = h.adapter(now)
      val result = adapter.prepare(resumed().toString())
      val material = BotaDeviceSDKEncryptedUploadV2Materials.remove(result["materialRegistrationId"] as String)!!
      h.requests.clear()
      expectFailure("BOTA_UPLOAD_PENDING") { material.finalize(evidence()) }
      assertEquals(60, h.requests.size)
      h.requests.clear()
      h.response = { throw UploadFailure("BOTA_UPLOAD_HTTP_403") }
      expectFailure("BOTA_UPLOAD_HTTP_403") { material.uploadContext!!(ByteArray(16)) }
      assertEquals(1, h.requests.size)
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun journalFsyncOrderIsFileRenameDirectoryAndFailuresPreventHttpDispatch() = runBlocking {
    val h = harness()
    try {
      val actions = mutableListOf<String>()
      val durability = object : JournalDurability {
        override fun syncFile(stream: FileOutputStream) { actions.add("file"); super.syncFile(stream) }
        override fun replace(source: File, target: File) { actions.add("rename"); super.replace(source, target) }
        override fun syncDirectory(directory: File) { actions.add("directory"); super.syncDirectory(directory) }
      }
      val journal = UploadJournal(h.directory, durability)
      val i = UploadInput.parse(input().toString())
      journal.save(i, JournalEntry(i.identitySha256, UploadPointer("rec_a")))
      assertEquals(listOf("file", "rename", "directory"), actions)
      val failing = UploadJournal(h.directory, object : JournalDurability {
        override fun syncFile(stream: FileOutputStream) { throw IOException("sensitive-path-and-token") }
      })
      val adapter = NativeUpload(failing, h.http, { "token" }, { ByteArray(16) }, { now })
      expectFailure("BOTA_UPLOAD_JOURNAL") { adapter.prepare(input().toString()) }
      assertTrue(h.requests.isEmpty())
      assertEquals(UploadPointer("rec_a"), journal.load(i)!!.pointer)
      assertFalse(h.directory.listFiles()!!.any { it.extension == "tmp" })
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun directoryFsyncFailureAfterRenameRetainsUnknownOutcomeAndBlocksHttp() = runBlocking {
    val h = harness()
    try {
      val journal = UploadJournal(h.directory, object : JournalDurability {
        override fun syncDirectory(directory: File) { throw IOException("cannot fsync") }
      })
      val adapter = NativeUpload(journal, h.http, { "token" }, { ByteArray(16) })
      expectFailure("BOTA_UPLOAD_JOURNAL") { adapter.prepare(input().toString()) }
      assertTrue(h.requests.isEmpty())
      expectFailure("BOTA_UPLOAD_UNKNOWN_OUTCOME") { h.adapter(now).prepare(input().toString()) }
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun corruptedJournalAndUnwhitelistedMetadataNeverBecomeMissing() = runBlocking {
    val h = harness()
    try {
      val i = UploadInput.parse(input().toString())
      h.journal.save(i, JournalEntry(i.identitySha256, UploadPointer("rec_a")))
      val path = h.directory.listFiles()!!.single()
      val valid = path.readText()
      path.writeText("{truncated")
      expectFailure("BOTA_UPLOAD_JOURNAL") { h.adapter(now).prepare(input().toString()) }
      path.writeText(JSONObject(valid).put("authorization", "opaque").toString())
      expectFailure("BOTA_UPLOAD_JOURNAL") { h.adapter(now).prepare(input().toString()) }
      assertTrue(h.requests.isEmpty())
    } finally { h.directory.deleteRecursively() }
  }

  @Test fun realHttpDrainsDelayedBodyOnRetainedRequestAndAbortsOrdinaryRequest() = runBlocking {
    for (retain in listOf(true, false)) {
      val headersSent = CountDownLatch(1)
      val releaseBody = CountDownLatch(1)
      val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
      server.createContext("/response") { exchange ->
        try {
          exchange.sendResponseHeaders(200, 0)
          exchange.responseBody.flush()
          headersSent.countDown()
          releaseBody.await(5, TimeUnit.SECONDS)
          exchange.responseBody.write("{\"id\":\"rec_a\"}".toByteArray())
        } finally { exchange.close() }
      }
      server.start()
      try {
        val operation = UploadOperation(UploadInput.parse(input().toString()))
        val task = async { runCatching {
          BackendUploadHttp().execute(UploadRequest("http://127.0.0.1:${server.address.port}", "/response", "GET", emptyMap(), null), operation, retain)
        } }
        withContext(Dispatchers.IO) { assertTrue(headersSent.await(5, TimeUnit.SECONDS)) }
        operation.cancel()
        releaseBody.countDown()
        val response = task.await()
        if (retain) assertEquals("rec_a", response.getOrThrow().getString("id"))
        else assertTrue(response.isFailure)
      } finally { releaseBody.countDown(); server.stop(0) }
    }
  }

  @Test fun retainedHttpRequiresCompleteAuthResponseEvenWhenCancelled() = runBlocking {
    for (status in listOf(401, 403)) for (completeBody in listOf(false, true)) {
      val dispatched = CountDownLatch(1)
      val release = CountDownLatch(1)
      val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
      server.createContext("/response") { exchange ->
        try {
          dispatched.countDown()
          release.await(5, TimeUnit.SECONDS)
          val bytes = "rejected".toByteArray()
          exchange.sendResponseHeaders(status, if (completeBody) bytes.size.toLong() else bytes.size + 20L)
          exchange.responseBody.write(bytes)
        } finally { exchange.close() }
      }
      server.start()
      try {
        val operation = UploadOperation(UploadInput.parse(input().toString()))
        val task = async { runCatching {
          BackendUploadHttp().execute(UploadRequest("http://127.0.0.1:${server.address.port}", "/response", "POST",
            emptyMap(), JSONObject()), operation, true)
        } }
        withContext(Dispatchers.IO) { assertTrue(dispatched.await(5, TimeUnit.SECONDS)) }
        operation.cancel()
        release.countDown()
        val error = task.await().exceptionOrNull() as UploadFailure
        assertEquals(if (completeBody) "BOTA_UPLOAD_HTTP_$status" else "BOTA_UPLOAD_TRANSPORT", error.code)
      } finally { release.countDown(); server.stop(0) }
    }
  }

  @Test fun realRegistryNonceStaysNativeAndIndependentFromUploadContextNonce() = runBlocking {
    val h = harness()
    val grant = ByteArray(16) { 19 }
    try {
      BotaDeviceSDKEncryptedUploadV2Materials.registerContext("operation-a", providerContext { grant })
      h.response = { if (it.path.endsWith("/recordings")) JSONObject().put("id", "rec_a") else session() }
      val adapter = NativeUpload(h.journal, h.http, { "token" }, BotaDeviceSDKEncryptedUploadV2Materials::readAuthNonce, { now })
      val decision = adapter.prepare(input().toString())
      assertEquals(encoded(grant), h.requests.single { it.path.endsWith("/sessions") }.body!!.getString("auth_nonce_base64"))
      BotaDeviceSDKEncryptedUploadV2Materials.removeContext("operation-a")
      val material = BotaDeviceSDKEncryptedUploadV2Materials.remove(decision["materialRegistrationId"] as String)!!
      h.response = { context("challenge") }
      val independentNonce = ByteArray(16) { 20 }
      material.uploadContext!!(independentNonce)
      assertEquals(encoded(independentNonce), h.requests.last().body!!.getString("nonce_base64"))
      assertFalse(decision.values.any { it is ByteArray })
      assertEquals("rec_a", decision["recordingId"])
      assertEquals(recordingUuid, material.recordingId)
    } finally {
      BotaDeviceSDKEncryptedUploadV2Materials.removeContext("operation-a")
      h.directory.deleteRecursively()
    }
  }

  @Test fun removedRegistryContextRejectsInFlightGrantNonceBeforeSessionCreation() = runBlocking {
    val h = harness()
    val reading = CompletableDeferred<Unit>()
    val nonce = CompletableDeferred<ByteArray>()
    try {
      BotaDeviceSDKEncryptedUploadV2Materials.registerContext("operation-a", providerContext {
        reading.complete(Unit); nonce.await()
      })
      h.response = { JSONObject().put("id", "rec_a") }
      val adapter = NativeUpload(h.journal, h.http, { "token" }, BotaDeviceSDKEncryptedUploadV2Materials::readAuthNonce, { now })
      val task = async { runCatching { adapter.prepare(input().toString()) } }
      reading.await()
      BotaDeviceSDKEncryptedUploadV2Materials.removeContext("operation-a")
      nonce.complete(ByteArray(16))
      assertEquals("BOTA_UPLOAD_NATIVE", (task.await().exceptionOrNull() as UploadFailure).code)
      assertEquals(1, h.requests.size)
      assertEquals(UploadPointer("rec_a"), h.journal.load(UploadInput.parse(input().toString()))!!.pointer)
    } finally {
      BotaDeviceSDKEncryptedUploadV2Materials.removeContext("operation-a")
      h.directory.deleteRecursively()
    }
  }

  @Test fun realRegistryReleaseCancelsUnusedMaterialAndPreservesJournal() = runBlocking {
    val h = harness()
    try {
      h.response = { session("staged") }
      val adapter = h.adapter(now)
      val decision = adapter.prepare(resumed().toString())
      val registrationId = decision["materialRegistrationId"] as String
      BotaDeviceSDKEncryptedUploadV2Materials.release(registrationId)
      BotaDeviceSDKEncryptedUploadV2Materials.release(registrationId)
      assertNull(BotaDeviceSDKEncryptedUploadV2Materials.remove(registrationId))
      expectFailure("BOTA_UPLOAD_NOT_COMPLETE") { adapter.complete("operation-a") }
      assertNotNull(h.journal.load(UploadInput.parse(input().toString())))
    } finally { h.directory.deleteRecursively() }
  }
}
