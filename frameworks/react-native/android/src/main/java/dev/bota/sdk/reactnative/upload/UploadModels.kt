package dev.bota.sdk.reactnative.upload

import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject

internal class UploadFailure(val code: String) : Exception(code)
internal fun fail(code: String): Nothing = throw UploadFailure("BOTA_UPLOAD_$code")
internal fun demand(value: Boolean, code: String = "INVALID_INPUT") { if (!value) fail(code) }
internal inline fun <T> sanitized(code: String, block: () -> T): T = try { block() }
  catch (error: UploadFailure) { throw error }
  catch (_: Exception) { fail(code) }
internal fun digest(value: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(value)
  .joinToString("") { "%02x".format(it.toInt() and 255) }
internal fun hex(value: String): ByteArray {
  demand(value.length % 2 == 0 && value.matches(Regex("[0-9a-fA-F]*")))
  return value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
internal fun encoded(value: ByteArray): String = Base64.getEncoder().encodeToString(value)
internal fun opaque(value: String, length: Int, hash: String? = null): ByteArray = sanitized("INVALID_DOCUMENT") {
  val bytes = Base64.getDecoder().decode(value)
  demand(bytes.size == length && encoded(bytes) == value && (hash == null || digest(bytes) == hash), "INVALID_DOCUMENT")
  bytes
}
internal fun JSONObject.string(key: String): String = (opt(key) as? String)?.also {
  demand(it.isNotEmpty() && it.length <= 8192)
} ?: fail("INVALID_INPUT")
internal fun JSONObject.integer(key: String, minimum: Long = 0, maximum: Long = 9007199254740991L): Long {
  val raw = opt(key) as? Number ?: fail("INVALID_INPUT")
  val text = raw.toString()
  demand(text.matches(Regex("0|[1-9][0-9]*")))
  val number = text.toLongOrNull() ?: fail("INVALID_INPUT")
  demand(number in minimum..maximum)
  return number
}
internal fun JSONObject.decimal(key: String, minimum: Long = 0): Long {
  val value = string(key)
  demand(value.matches(Regex("0|[1-9][0-9]*")))
  return (value.toLongOrNull() ?: fail("INVALID_INPUT")).also { demand(it in minimum..9007199254740991L) }
}
internal fun uuid(value: String): String = value.also {
  demand(it.matches(Regex("[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")))
}
internal fun hashString(value: String): String = value.also { demand(it.matches(Regex("[0-9a-f]{64}"))) }
internal fun JSONObject.optionalObject(key: String): JSONObject? {
  if (!has(key) || isNull(key)) return null
  return opt(key) as? JSONObject ?: fail("INVALID_INPUT")
}
internal fun timestamp(value: String): Long = sanitized("INVALID_DOCUMENT") { Instant.parse(value).toEpochMilli() }

internal data class UploadScope(
  val apiOrigin: String, val accountId: String, val projectId: String, val organizationId: String,
  val environment: String, val endUserId: String, val deviceId: String,
  val bindingGeneration: Long, val serialNumber: String, val nativeDeviceId: String, val scopeKey: String,
  val apiBasePath: String = "/v1",
) {
  fun identity(includeTransport: Boolean = false): List<Any> = listOf(apiOrigin, accountId, projectId, organizationId, environment, endUserId,
    deviceId, bindingGeneration, serialNumber, if (includeTransport) nativeDeviceId else "", scopeKey, apiBasePath)

  companion object {
    fun parse(json: JSONObject): UploadScope {
      val origin = json.string("apiOrigin")
      val url = URI(origin)
      demand(url.scheme == "https" && !url.host.isNullOrEmpty() && url.rawUserInfo == null &&
        url.rawQuery == null && url.rawFragment == null && (url.rawPath.isNullOrEmpty() || url.rawPath == "/"))
      fun identifier(key: String) = json.string(key).also { demand(it.matches(Regex("[A-Za-z0-9_-]{1,256}"))) }
      return UploadScope(origin.trimEnd('/'), identifier("accountId"), identifier("projectId"), json.optString("organizationId", "").also { demand(it.isEmpty() || it.matches(Regex("[A-Za-z0-9_-]{1,256}"))) },
        identifier("environment"), identifier("endUserId"), identifier("deviceId"), json.integer("bindingGeneration"),
        json.string("serialNumber"), json.string("nativeDeviceId"), json.string("scopeKey"),
        json.optString("apiBasePath", "/v1").also { demand(it.matches(Regex("(/[A-Za-z0-9_-]+)+"))) })
    }
  }
}

internal data class UploadRecording(
  val uuid: String, val generation: Long, val ciphertextLength: Long, val ciphertextSha256: String,
  val startedAtMs: Long, val durationMs: Long, val plaintextLength: Long, val storageFormat: Long,
) {
  fun identity(): List<Any> = listOf(uuid, generation, ciphertextLength.toString(), ciphertextSha256,
    startedAtMs.toString(), durationMs.toString(), plaintextLength.toString(), storageFormat)

  companion object {
    fun parse(json: JSONObject): UploadRecording = UploadRecording(uuid(json.string("uuid")),
      json.integer("generation", 1, 4294967295), json.decimal("ciphertextLength", 1),
      hashString(json.string("ciphertextSha256")), json.decimal("startedAtMs"), json.decimal("durationMs"),
      json.decimal("plaintextLength"), json.integer("storageFormat", 3, 3)).also {
      demand(it.startedAtMs + it.durationMs <= 8640000000000000L)
    }
  }
}

internal data class UploadPointer(val recordingId: String, val sessionId: String? = null, val ownerRevision: Long? = null) {
  fun fingerprint(): String = digest(JSONArray(listOf(recordingId, sessionId ?: JSONObject.NULL,
    ownerRevision ?: JSONObject.NULL)).toString().toByteArray(Charsets.UTF_8))
  fun json(): JSONObject = JSONObject().put("recordingId", recordingId).apply {
    if (sessionId != null) put("sessionId", sessionId).put("ownerRevision", ownerRevision)
  }
  companion object {
    fun parse(json: JSONObject): UploadPointer {
      val id = json.string("recordingId")
      demand(id.matches(Regex("rec_[A-Za-z0-9_-]+")))
      val hasSession = json.has("sessionId") && !json.isNull("sessionId")
      val hasRevision = json.has("ownerRevision") && !json.isNull("ownerRevision")
      demand(hasSession == hasRevision)
      return UploadPointer(id, if (hasSession) uuid(json.string("sessionId")) else null,
        if (hasRevision) json.integer("ownerRevision", 1, Int.MAX_VALUE.toLong()) else null)
    }
  }
}

internal data class UploadInput(
  val operationId: String, val scope: UploadScope, val recording: UploadRecording,
  val capability: ByteArray, val flags: Long, val journalKey: String, val identitySha256: String,
  val prior: UploadPointer?, val checkpoint: JSONObject?,
) {
  val legacyIdentitySha256: String get() = digest(JSONArray(scope.identity(includeTransport = true) +
    recording.identity()).toString().toByteArray(Charsets.UTF_8))

  fun validateCheckpoint(pointer: UploadPointer?) {
    val cp = checkpoint ?: return
    sanitized("IDENTITY_CONFLICT") {
      demand(pointer?.sessionId != null && pointer.ownerRevision != null, "IDENTITY_CONFLICT")
      val session = uuid(cp.string("uploadSessionId"))
      cp.integer("version", 1, 1)
      val revision = cp.integer("ownerRevision", 1, Int.MAX_VALUE.toLong())
      demand(revision <= pointer!!.ownerRevision!! &&
        ((revision == pointer.ownerRevision) == (session == pointer.sessionId)), "IDENTITY_CONFLICT")
      demand(cp.decimal("nextCiphertextOffset") <= recording.ciphertextLength, "IDENTITY_CONFLICT")
      hashString(cp.string("prefixSha256"))
      cp.integer("revision", 1, 4294967295)
      val transport = cp.string("transportSessionId")
      demand(transport.matches(Regex("[1-9][0-9]*")) && transport.toULongOrNull() != null)
      cp.string("sinkRegistrationId")
      cp.integer("windowPackets", 1, 65535)
      cp.integer("dataPayloadBytes", 1, 65535)
      if (cp.has("highestContiguousSequence") && !cp.isNull("highestContiguousSequence"))
        cp.integer("highestContiguousSequence", 0, 4294967295)
      // Legacy identity fields, if supplied during migration, cannot contradict this recording.
      if (cp.has("recordingUuid")) demand(cp.string("recordingUuid") == recording.uuid, "IDENTITY_CONFLICT")
      if (cp.has("recordingGeneration")) demand(cp.integer("recordingGeneration") == recording.generation, "IDENTITY_CONFLICT")
      if (cp.has("ciphertextLength")) demand(cp.decimal("ciphertextLength") == recording.ciphertextLength, "IDENTITY_CONFLICT")
      if (cp.has("ciphertextSha256")) demand(cp.string("ciphertextSha256") == recording.ciphertextSha256, "IDENTITY_CONFLICT")
    }
  }

  companion object {
    fun parse(text: String): UploadInput = sanitized("INVALID_INPUT") {
      demand(text.length <= 32768)
      val json = JSONObject(text)
      val operation = json.string("operationId").also { demand(it.length <= 256) }
      val scope = UploadScope.parse(json.getJSONObject("scope"))
      val recording = UploadRecording.parse(json.getJSONObject("recording"))
      val capability = json.getJSONObject("capability")
      val bytes = hex(capability.string("rawValueHex"))
      demand(bytes.size == 24)

      val keyFields = listOf(scope.scopeKey, scope.deviceId, scope.bindingGeneration, recording.uuid,
        recording.generation, recording.ciphertextLength.toString(), recording.ciphertextSha256)
      // Android org.json escapes slashes; the existing JS journal key uses JSON.stringify.
      val keyJson = JSONArray(keyFields).toString().replace("\\/", "/")
      val key = digest(keyJson.toByteArray(Charsets.UTF_8))
      if (json.has("journalKey")) demand(hashString(json.string("journalKey")) == key, "IDENTITY_CONFLICT")
      val identity = digest(JSONArray(scope.identity() + recording.identity()).toString().toByteArray(Charsets.UTF_8))
      UploadInput(operation, scope, recording, bytes, capability.integer("flags", 0, 4294967295), key, identity,
        json.optionalObject("priorJournalEntry")?.let(UploadPointer::parse), json.optionalObject("checkpoint"))
    }
  }
}
