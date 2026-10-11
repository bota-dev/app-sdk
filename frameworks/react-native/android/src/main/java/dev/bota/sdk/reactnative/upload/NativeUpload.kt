package dev.bota.sdk.reactnative.upload

import dev.bota.sdk.EncryptedUploadV2ContextExchange
import dev.bota.sdk.EncryptedUploadV2Material
import dev.bota.sdk.EncryptedUploadV2SecurityPolicy
import dev.bota.sdk.EncryptedUploadV2TransferEvidence
import dev.bota.sdk.reactnative.BotaDeviceSDKEncryptedUploadV2Materials
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

internal class NativeUpload(
  private val journal: UploadJournal,
  private val http: UploadHttp,
  private val credentials: suspend (UploadOperation) -> String,
  private val readNonce: suspend (String) -> ByteArray,
  private val now: () -> Long = System::currentTimeMillis,
  private val wait: suspend (Long, UploadOperation) -> Unit = { milliseconds, op ->
    op.check(); delay(milliseconds); op.check()
  },
) {
  private val operations = mutableMapOf<String, Attempt>()
  private val usedOperations = mutableSetOf<String>()
  private val journalOwners = mutableSetOf<String>()

  suspend fun prepare(text: String): Map<String, Any> {
    val input = UploadInput.parse(text)
    val attempt = synchronized(this) {
      demand(input.operationId !in usedOperations && input.journalKey !in journalOwners, "BUSY")
      usedOperations.add(input.operationId)
      journalOwners.add(input.journalKey)
      Attempt(UploadOperation(input)).also { operations[input.operationId] = it }
    }
    try {
      return attempt.prepare()
    } catch (error: Exception) {
      cancel(input.operationId)
      synchronized(this) { journalOwners.remove(input.journalKey); operations.remove(input.operationId) }
      if (error is UploadFailure) throw error
      fail("NATIVE")
    } finally {
      attempt.preparing = false
      if (attempt.cancelled) synchronized(this) {
        journalOwners.remove(input.journalKey)
        operations.remove(input.operationId)
      }
    }
  }

  fun cancel(operationId: String) {
    val attempt = synchronized(this) {
      usedOperations.add(operationId)
      operations[operationId]
    } ?: return
    attempt.cancelled = true
    attempt.operation.cancel()
    synchronized(attempt.operation) {
      attempt.operation.registrationId?.let { BotaDeviceSDKEncryptedUploadV2Materials.remove(it) }
      attempt.operation.registrationId = null
    }
    if (!attempt.preparing) synchronized(this) {
      journalOwners.remove(attempt.input.journalKey)
      operations.remove(operationId)
    }
  }

  fun cancelAll() { synchronized(this) { operations.keys.toList() }.forEach(::cancel) }

  suspend fun complete(operationId: String) {
    val attempt = synchronized(this) { operations[operationId] } ?: fail("NOT_COMPLETE")
    attempt.callbacks.withLock {
      attempt.operation.active {
        // Only the parent calls complete after the SDK's successful receipt/CONFIRM result.
        demand(attempt.receiptDelivered && !attempt.preparing, "NOT_COMPLETE")
        journal.remove(attempt.input, attempt.pointer ?: fail("NOT_COMPLETE"))
      }
      cancel(operationId)
    }
  }

  private inner class Attempt(val operation: UploadOperation) {
    val input = operation.input
    val callbacks = Mutex()
    @Volatile var preparing = true
    @Volatile var cancelled = false
    var pointer: UploadPointer? = null
    var receiptDelivered = false
    private var session: JSONObject? = null
    private var uploadCiphertext = true
    private var sendManifest = true
    private var receipt: ByteArray? = null
    private var importedPriorSha256: String? = null
    private var authorizationNonceSha256: String? = null
    private var recoveryNonceBase64: String? = null
    private val base = input.scope.apiBasePath
    private val contexts = "$base/devices/${input.scope.deviceId}/encrypted-upload-v2/contexts"
    private fun sessions() = "$base/recordings/${pointer!!.recordingId}/encrypted-upload-v2/sessions"
    private fun sessionPath() = "${sessions()}/${pointer!!.sessionId}"

    private fun save(value: UploadPointer, nonceHash: String? = authorizationNonceSha256, recoveryNonce: String? = null) {
      journal.save(input, JournalEntry(input.identitySha256, value, importedPriorSha256 = importedPriorSha256,
        authorizationNonceSha256 = nonceHash, recoveryNonceBase64 = recoveryNonce))
      pointer = value
      authorizationNonceSha256 = nonceHash
      recoveryNonceBase64 = recoveryNonce
    }

    private suspend fun request(path: String, body: JSONObject? = null, retain: Boolean = false,
      beforeDispatch: () -> Unit = {}): JSONObject {
      operation.check()
      val token = credentials(operation)
      operation.check()
      val headers = mutableMapOf("Authorization" to "Bearer $token",
        "Accept" to "application/json", "Content-Type" to "application/json")
      if (input.scope.organizationId.isNotEmpty()) headers["X-Organization-Id"] = input.scope.organizationId
      val result = http.execute(UploadRequest(input.scope.apiOrigin, path, if (body == null) "GET" else "POST", headers, body),
        operation, retain, beforeDispatch)
      if (!retain) operation.check()
      return result
    }

    private suspend fun createRequest(path: String, body: JSONObject, phase: String): JSONObject {
      val previous = pointer?.let { JournalEntry(input.identitySha256, it, importedPriorSha256 = importedPriorSha256,
        authorizationNonceSha256 = authorizationNonceSha256) }
      val marker = JournalEntry(input.identitySha256, pointer, phase, importedPriorSha256, authorizationNonceSha256)
      var marked = false
      try {
        return request(path, body, true) {
          demand(journal.load(input) == previous, "IDENTITY_CONFLICT")
          journal.save(input, marker)
          marked = true
        }
      } catch (error: UploadFailure) {
        if (marked && error.code in setOf("BOTA_UPLOAD_HTTP_401", "BOTA_UPLOAD_HTTP_403")) {
          // A retained rejection settles its originating journal even after cancellation.
          synchronized(this@NativeUpload) {
            demand(preparing && operations[input.operationId] === this && input.journalKey in journalOwners, "IDENTITY_CONFLICT")
            journal.rollbackRejectedCreate(input, marker, previous)
          }
        }
        operation.check()
        throw error
      }
    }

    private suspend fun <T> retry(block: suspend () -> T): T {
      for (attempt in 0..2) {
        operation.check()
        try { return block().also { operation.check() } }
        catch (error: UploadFailure) {
          operation.check()
          val status = error.code.removePrefix("BOTA_UPLOAD_HTTP_").toIntOrNull()
          if (attempt == 2 || !(error.code == "BOTA_UPLOAD_TRANSPORT" || status == 429 || (status != null && status >= 500))) throw error
          wait(250, operation)
        }
      }
      fail("NATIVE")
    }

    private suspend fun nonce(): String {
      operation.check()
      val bytes = readNonce(input.operationId)
      operation.check()
      demand(bytes.size == 16, "INVALID_DOCUMENT")
      return encoded(bytes)
    }

    suspend fun prepare(): Map<String, Any> {
      operation.check()
      val saved = journal.load(input)
      if (saved != null) {
        demand(saved.phase == "ready", "UNKNOWN_OUTCOME")
        pointer = saved.pointer
        importedPriorSha256 = saved.importedPriorSha256
        authorizationNonceSha256 = saved.authorizationNonceSha256
        recoveryNonceBase64 = saved.recoveryNonceBase64
      } else if (input.prior != null) {
        input.validateCheckpoint(input.prior)
        importedPriorSha256 = input.prior.fingerprint()
        operation.active { save(input.prior) }
      }
      input.validateCheckpoint(pointer)
      if (pointer == null) {
        val body = JSONObject().put("device_id", input.scope.deviceId).put("end_user_id", input.scope.endUserId)
          .put("upload_method", "ble").put("streaming", false).put("metadata", JSONObject()
            .put("started_at", Instant.ofEpochMilli(input.recording.startedAtMs).toString())
            .put("ended_at", Instant.ofEpochMilli(input.recording.startedAtMs + input.recording.durationMs).toString()))
        // No automatic retry: an unknown initial outcome must remain durable across process restart.
        withContext(NonCancellable) {
          val response = createRequest("$base/recordings", body, "recording_create_unknown")
          val id = UploadPointer.parse(JSONObject().put("recordingId", response.string("id")))
          save(id)
        }
        operation.check()
      }
      if (pointer!!.sessionId == null) {
        val authNonce = nonce()
        val body = JSONObject().put("device_id", input.scope.deviceId).put("binding_generation", input.scope.bindingGeneration)
          .put("recording_uuid", input.recording.uuid).put("recording_generation", input.recording.generation)
          .put("storage_format", "bota_enc_v2").put("channel", "ble").put("capabilities_base64", encoded(input.capability))
          .put("auth_nonce_base64", authNonce).put("ciphertext_length", input.recording.ciphertextLength)
          .put("ciphertext_sha256", input.recording.ciphertextSha256)
        withContext(NonCancellable) {
          val created = createRequest(sessions(), body, "session_create_unknown")
          save(responsePointer(created), digest(opaque(authNonce, 16)))
          operation.check()
          session = created
        }
      } else {
        val visited = mutableSetOf(pointer!!.sessionId!!)
        var replacements = 0
        while (true) {
          val status = request(sessionPath())
          validateIdentity(status)
          val state = status.string("state")
          val expiry = timestamp(status.string("expires_at"))
          val expired = state == "expired" || (state in setOf("created", "staging", "staged") && expiry <= now())
          val authNonce = recoveryNonceBase64 ?: if (expired || (authorizationNonceSha256 != null && state in setOf("created", "staging", "staged"))) nonce() else null
          val nonceHash = authNonce?.let { digest(opaque(it, 16)) }
          val nonceChanged = authorizationNonceSha256 != null && nonceHash != null && nonceHash != authorizationNonceSha256
          if (recoveryNonceBase64 == null && !expired && !nonceChanged) { applyStatus(status); session = status; break }
          demand(input.flags and 0x37f == 0x37fL, "EXPIRED")
          demand(replacements < 3, "RECOVERY_LIMIT")
          val parent = pointer!!
          val path = sessionPath() + "/recover"
          val body = JSONObject().put("owner_revision", parent.ownerRevision).put("auth_nonce_base64", authNonce)
            .put("capabilities_base64", encoded(input.capability))
          if (!expired) body.put("reason", "nonce_changed")
          // Retrying a lost response must use the nonce of the original request.
          save(parent, recoveryNonce = authNonce)
          retry {
            withContext(NonCancellable) {
              val recovered = responsePointer(request(path, body, true))
              demand(recovered.ownerRevision!! > parent.ownerRevision!! && recovered.sessionId !in visited, "IDENTITY_CONFLICT")
              save(recovered, nonceHash)
              visited.add(recovered.sessionId!!)
            }
          }
          replacements++
        }
      }
      operation.check()
      val selected = session!!
      val policy = selected.string("policy")
      val nativePolicy = when (policy) {
        "legacy_allowed" -> EncryptedUploadV2SecurityPolicy.LegacyAllowed
        "v2_preferred" -> EncryptedUploadV2SecurityPolicy.V2Preferred
        "v2_required" -> EncryptedUploadV2SecurityPolicy.V2Required
        else -> fail("INVALID_DOCUMENT")
      }
      timestamp(selected.string("expires_at"))
      var authorization = opaque(selected.string("authorization_base64"), 408, selected.string("authorization_sha256"))
      if (input.recording.markersRequired) {
        val path = sessionPath() + "/markers/authorization"
        val admission = try {
          retry { request(path + "?owner_revision=" + pointer!!.ownerRevision) }
        } catch (error: UploadFailure) {
          if (error.code != "BOTA_UPLOAD_HTTP_404" || selected.optString("state") !in setOf("", "created", "staging", "staged")) throw error
          retry { request(path, JSONObject().put("owner_revision", pointer!!.ownerRevision)
            .put("request_uuid", pointer!!.sessionId)) }
        }
        demand(admission.string("profile") == "recording-markers/1", "INVALID_DOCUMENT")
        authorization += opaque(admission.string("context_base64"), 176)
        authorization += opaque(admission.string("authorization_base64"), 280, admission.string("authorization_sha256"))
      }
      val material = EncryptedUploadV2Material(
        materialId = UUID.randomUUID().toString(), recordingId = input.recording.uuid,
        uploadSessionId = UUID.fromString(pointer!!.sessionId), ownerRevision = pointer!!.ownerRevision!!.toUInt(),
        policy = nativePolicy, authorization = authorization,
        stagingRequest = { evidence -> callbacks.withLock { staging(evidence) } },
        submitManifest = { bytes, evidence -> callbacks.withLock { manifest(bytes, evidence) } },
        submitMarkers = if (input.recording.markersRequired) { documents, evidence ->
          callbacks.withLock { markers(documents, evidence) }
        } else null,
        finalize = { evidence -> callbacks.withLock { finalize(evidence) } },
        completionReceipt = { evidence -> callbacks.withLock {
          verifyEvidence(evidence)
          val bytes = receipt ?: fail("NOT_COMPLETE")
          receiptDelivered = true
          bytes.copyOf()
        } },
        cancel = { this@NativeUpload.cancel(input.operationId) },
        uploadContext = { nonce -> context(nonce) },
        shouldUploadCiphertext = { evidence -> callbacks.withLock { verifyEvidence(evidence); uploadCiphertext } },
        reconcileStaging = { bytes, evidence -> callbacks.withLock { reconcileStaging(bytes, evidence) } },
      )
      return operation.active {
        val registration = BotaDeviceSDKEncryptedUploadV2Materials.register(material)
        operation.registrationId = registration
        mapOf("profile" to "encrypted_upload_v2", "uploadSessionId" to pointer!!.sessionId!!,
          "ownerRevision" to pointer!!.ownerRevision!!, "securityPolicy" to policy,
          "materialRegistrationId" to registration, "recordingId" to pointer!!.recordingId)
      }
    }

    private fun responsePointer(value: JSONObject): UploadPointer {
      demand(value.string("profile") == "encrypted_upload_v2", "IDENTITY_CONFLICT")
      return UploadPointer.parse(JSONObject().put("recordingId", pointer!!.recordingId)
        .put("sessionId", value.string("session_id")).put("ownerRevision", value.integer("owner_revision", 1, Int.MAX_VALUE.toLong())))
    }
    private fun validateIdentity(value: JSONObject) {
      demand(responsePointer(value) == pointer && value.string("channel") == "ble" &&
        value.integer("ciphertext_length", 1) == input.recording.ciphertextLength &&
        value.string("ciphertext_sha256") == input.recording.ciphertextSha256, "IDENTITY_CONFLICT")
    }
    private fun applyStatus(value: JSONObject) {
      validateIdentity(value)
      when (value.string("state")) {
        "staging" -> { uploadCiphertext = true; sendManifest = true }
        "staged" -> { uploadCiphertext = false; sendManifest = true }
        "ready", "processing", "published" -> { uploadCiphertext = false; sendManifest = false }
        else -> fail("STATE")
      }
    }
    private fun verifyEvidence(evidence: EncryptedUploadV2TransferEvidence) {
      operation.check()
      demand(evidence.ciphertextLength == input.recording.ciphertextLength.toULong() &&
        evidence.ciphertextSha256.contentEquals(hex(input.recording.ciphertextSha256)), "INVALID_DOCUMENT")
    }
    private suspend fun reconcileStaging(bytes: ByteArray, evidence: EncryptedUploadV2TransferEvidence): Boolean {
      verifyEvidence(evidence)
      if (!uploadCiphertext) return false
      return try { retry { manifest(bytes, evidence) }; false }
      catch (error: UploadFailure) {
        if (error.code == "BOTA_UPLOAD_STAGING_MISSING") true else throw error
      }
    }
    private suspend fun staging(evidence: EncryptedUploadV2TransferEvidence): Request {
      verifyEvidence(evidence)
      demand(uploadCiphertext, "STATE")
      demand(timestamp(session!!.string("expires_at")) > now(), "EXPIRED")
      val target = request(sessionPath() + "/staging-url", JSONObject().put("owner_revision", pointer!!.ownerRevision))
      operation.check()
      demand(timestamp(session!!.string("expires_at")) > now(), "EXPIRED")
      return sanitized("INVALID_DOCUMENT") {
        demand(target.string("method") == "PUT", "INVALID_DOCUMENT")
        val url = target.string("url").toHttpUrl()
        demand(url.isHttps && url.username.isEmpty() && url.password.isEmpty() && url.fragment == null, "INVALID_DOCUMENT")
        val headers = target.getJSONObject("headers")
        val builder = Request.Builder().url(url)
        headers.keys().forEach { key ->
          val value = headers.opt(key) as? String ?: fail("INVALID_DOCUMENT")
          demand(!key.equals("Authorization", true) && !key.equals("Cookie", true), "INVALID_DOCUMENT")
          builder.header(key, value)
        }
        // SDK replaces this bodyless template with its verified native ciphertext source.
        builder.put(ByteArray(0).toRequestBody(null)).build()
      }
    }
    private suspend fun manifest(bytes: ByteArray, evidence: EncryptedUploadV2TransferEvidence) {
      verifyEvidence(evidence)
      demand(bytes.size == 580 && evidence.manifestLength.toInt() == 580 &&
        digest(bytes) == evidence.manifestSha256.joinToString("") { "%02x".format(it.toInt() and 255) }, "INVALID_DOCUMENT")
      if (!sendManifest) return
      request(sessionPath() + "/manifest", JSONObject().put("owner_revision", pointer!!.ownerRevision)
        .put("manifest_base64", encoded(bytes)).put("manifest_sha256", digest(bytes)))
      uploadCiphertext = false
      sendManifest = false
    }
    private suspend fun markers(documents: List<ByteArray>, evidence: EncryptedUploadV2TransferEvidence) {
      verifyEvidence(evidence)
      demand(input.recording.markersRequired && documents.size in 2..4097 && documents[0].size == 200 &&
        documents.drop(1).all { it.size in 216..402 }, "INVALID_DOCUMENT")
      val pages = org.json.JSONArray()
      documents.drop(1).forEach { pages.put(encoded(it)) }
      retry { request(sessionPath() + "/markers/batch", JSONObject().put("owner_revision", pointer!!.ownerRevision)
        .put("seal_base64", encoded(documents[0])).put("pages_base64", pages)) }
    }
    private suspend fun finalize(evidence: EncryptedUploadV2TransferEvidence) {
      verifyEvidence(evidence)
      for (poll in 0 until 60) {
        val status = retry { request(sessionPath()) }
        applyStatus(status)
        if (status.string("state") == "published") {
          demand(status.integer("plaintext_length") == input.recording.plaintextLength, "INVALID_DOCUMENT")
          val audio = opaque(status.string("completion_receipt_base64"), 336, status.string("completion_receipt_sha256"))
          receipt = if (input.recording.markersRequired) audio + opaque(
            (status.opt("marker_completion_receipt_base64") as? String ?: fail("INVALID_DOCUMENT")), 296,
            (status.opt("marker_completion_receipt_sha256") as? String ?: fail("INVALID_DOCUMENT"))) else audio
          return
        }
        wait(2000, operation)
      }
      fail("PENDING")
    }

    private suspend fun context(nonce: ByteArray): EncryptedUploadV2ContextExchange {
      operation.check()
      demand(nonce.size == 16, "INVALID_DOCUMENT")
      val body = JSONObject().put("nonce_base64", encoded(nonce))
      val initial = retry { request(contexts, body) }
      val id = uuid(initial.string("context_id"))
      val expiry = initial.string("expires_at")
      timestamp(expiry)
      demand(initial.string("state") in setOf("challenge", "pending", "complete"), "INVALID_DOCUMENT")
      val challengeBase64 = initial.string("challenge_base64")
      val challenge = opaque(challengeBase64, 196)
      return EncryptedUploadV2ContextExchange(challenge) { proof ->
        operation.check()
        demand(proof.size in 116..366, "INVALID_DOCUMENT")
        val proofBody = JSONObject().put("proof_base64", encoded(proof))
        var response = retry { request("$contexts/$id/proof", proofBody) }
        for (poll in 0..100) {
          operation.check()
          demand(response.string("context_id") == id && response.string("challenge_base64") == challengeBase64 &&
            response.string("expires_at") == expiry, "IDENTITY_CONFLICT")
          when (response.string("state")) {
            "complete" -> return@EncryptedUploadV2ContextExchange opaque(response.string("result_base64"), 264)
            "pending" -> demand(response.has("result_base64") && response.isNull("result_base64"), "INVALID_DOCUMENT")
            else -> fail("STATE")
          }
          if (poll == 100) break
          wait(250, operation)
          response = retry { request("$contexts/$id") }
        }
        fail("PENDING")
      }
    }
  }
}
