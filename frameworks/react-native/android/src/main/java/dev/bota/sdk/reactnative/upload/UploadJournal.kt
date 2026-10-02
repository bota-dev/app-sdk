package dev.bota.sdk.reactnative.upload

import java.io.File
import java.io.FileOutputStream
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.StandardOpenOption.READ
import java.util.UUID
import org.json.JSONObject

internal data class JournalEntry(val identitySha256: String, val pointer: UploadPointer?, val phase: String = "ready",
  val importedPriorSha256: String? = null, val authorizationNonceSha256: String? = null,
  val recoveryNonceBase64: String? = null) {
  fun json(): JSONObject = (pointer?.json() ?: JSONObject()).put("version", 2)
    .put("identitySha256", identitySha256).put("phase", phase).apply {
      if (importedPriorSha256 != null) put("importedPriorSha256", importedPriorSha256)
      if (authorizationNonceSha256 != null) put("authorizationNonceSha256", authorizationNonceSha256)
      if (recoveryNonceBase64 != null) put("recoveryNonceBase64", recoveryNonceBase64)
    }
}

internal interface JournalDurability {
  fun syncFile(stream: FileOutputStream) { stream.fd.sync() }
  fun replace(source: File, target: File) { Files.move(source.toPath(), target.toPath(), ATOMIC_MOVE, REPLACE_EXISTING) }
  fun syncDirectory(directory: File) { FileChannel.open(directory.toPath(), READ).use { it.force(true) } }
}

internal class UploadJournal(private val root: File, private val durability: JournalDurability = object : JournalDurability {}) {
  private fun directory() {
    val path = root.toPath()
    if (!Files.exists(path, NOFOLLOW_LINKS)) {
      demand(root.mkdir(), "JOURNAL")
      durability.syncDirectory(root.parentFile!!)
    }
    demand(Files.isDirectory(path, NOFOLLOW_LINKS) && !Files.isSymbolicLink(path), "JOURNAL")
  }
  private fun file(key: String): File = File(root, "${hashString(key)}.json")

  @Synchronized fun load(input: UploadInput): JournalEntry? = sanitized("JOURNAL") {
    directory()
    val file = file(input.journalKey)
    if (!Files.exists(file.toPath(), NOFOLLOW_LINKS)) return@sanitized null
    demand(Files.isRegularFile(file.toPath(), NOFOLLOW_LINKS) && file.length() <= 4096, "JOURNAL")
    val json = JSONObject(file.readText(Charsets.UTF_8))
    val allowed = setOf("version", "identitySha256", "phase", "recordingId", "sessionId", "ownerRevision", "importedPriorSha256", "authorizationNonceSha256", "recoveryNonceBase64")
    demand(json.keys().asSequence().all { it in allowed }, "JOURNAL")
    val version = json.integer("version", 1, 2)
    val identity = hashString(json.string("identitySha256"))
    demand(identity == (if (version == 1L) input.legacyIdentitySha256 else input.identitySha256), "IDENTITY_CONFLICT")
    val phase = json.string("phase")
    demand(phase in setOf("ready", "recording_create_unknown", "session_create_unknown"), "JOURNAL")
    val pointer = if (json.has("recordingId")) UploadPointer.parse(json) else null
    val imported = if (json.has("importedPriorSha256")) hashString(json.string("importedPriorSha256")) else null
    val nonceHash = if (json.has("authorizationNonceSha256")) hashString(json.string("authorizationNonceSha256")) else null
    demand(nonceHash == null || pointer?.sessionId != null, "JOURNAL")
    val recoveryNonce = if (json.has("recoveryNonceBase64")) json.string("recoveryNonceBase64").also { opaque(it, 16) } else null
    demand(recoveryNonce == null || (phase == "ready" && pointer?.sessionId != null), "JOURNAL")
    demand(if (phase == "recording_create_unknown") pointer == null else pointer != null, "JOURNAL")
    demand(phase != "session_create_unknown" || pointer?.sessionId == null, "JOURNAL")
    if (input.prior != null && pointer != null) {
      demand(input.prior.recordingId == pointer.recordingId &&
        (input.prior.sessionId == null || input.prior.fingerprint() == imported ||
          (input.prior.sessionId == pointer.sessionId && input.prior.ownerRevision == pointer.ownerRevision)),
        "IDENTITY_CONFLICT")
    }
    JournalEntry(input.identitySha256, pointer, phase, imported, nonceHash, recoveryNonce).also {
      if (version == 1L) save(input, it)
    }
  }

  @Synchronized fun save(input: UploadInput, entry: JournalEntry) = sanitized("JOURNAL") {
    directory()
    demand(entry.identitySha256 == input.identitySha256, "IDENTITY_CONFLICT")
    val target = file(input.journalKey)
    demand(!Files.isSymbolicLink(target.toPath()), "JOURNAL")
    val temporary = File(root, ".${input.journalKey}.${UUID.randomUUID()}.tmp")
    try {
      demand(temporary.createNewFile(), "JOURNAL")
      FileOutputStream(temporary).use { stream ->
        stream.write(entry.json().toString().toByteArray(Charsets.UTF_8))
        durability.syncFile(stream)
      }
      durability.replace(temporary, target)
      durability.syncDirectory(root)
    } finally { if (temporary.exists()) temporary.delete() }
  }

  @Synchronized fun remove(input: UploadInput, expected: UploadPointer) = sanitized("JOURNAL") {
    val current = load(input) ?: fail("IDENTITY_CONFLICT")
    demand(current.phase == "ready" && current.pointer == expected, "IDENTITY_CONFLICT")
    Files.delete(file(input.journalKey).toPath())
    durability.syncDirectory(root)
  }

  @Synchronized fun rollbackRejectedCreate(input: UploadInput, marker: JournalEntry, previous: JournalEntry?) = sanitized("JOURNAL") {
    demand(load(input) == marker, "IDENTITY_CONFLICT")
    when (marker.phase) {
      "recording_create_unknown" -> demand(previous == null && marker.pointer == null, "IDENTITY_CONFLICT")
      "session_create_unknown" -> demand(previous?.phase == "ready" && previous.copy(phase = marker.phase) == marker, "IDENTITY_CONFLICT")
      else -> fail("IDENTITY_CONFLICT")
    }
    if (previous == null) {
      Files.delete(file(input.journalKey).toPath())
      durability.syncDirectory(root)
    } else {
      save(input, previous)
    }
  }
}
