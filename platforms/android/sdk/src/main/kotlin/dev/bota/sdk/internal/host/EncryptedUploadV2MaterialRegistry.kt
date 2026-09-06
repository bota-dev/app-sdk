package dev.bota.sdk.internal.host

import dev.bota.sdk.EncryptedUploadV2Material
import dev.bota.sdk.EncryptedUploadV2TransferEvidence
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.Request

internal enum class EncryptedUploadV2TerminalOutcome {
    Completed,
    Cancelled,
    Failed,
}

internal class EncryptedUploadV2MaterialRegistryException(message: String) :
    IllegalArgumentException(message)

internal data class EncryptedUploadV2MaterialLease(internal val registrationId: UUID)

internal class EncryptedUploadV2PreparedMaterial(
    authorization: ByteArray,
    authorizationSha256: ByteArray,
    val lease: EncryptedUploadV2MaterialLease,
) {
    val authorization: ByteArray = authorization.copyOf()
    val authorizationSha256: ByteArray = authorizationSha256.copyOf()
}

internal class EncryptedUploadV2AcceptedReceipt(receipt: ByteArray, receiptSha256: ByteArray) {
    val receipt: ByteArray = receipt.copyOf()
    val receiptSha256: ByteArray = receiptSha256.copyOf()
}

internal class EncryptedUploadV2MaterialRegistry {
    private data class Entry(val registrationId: UUID, val material: EncryptedUploadV2Material)

    private val mutex = Mutex()
    private val entries = mutableMapOf<String, Entry>()

    suspend fun register(id: String, material: EncryptedUploadV2Material) {
        requireMaterialId(id)
        if (material.authorization.size != AuthorizationBytes) {
            throw EncryptedUploadV2MaterialRegistryException("authorization must be exactly $AuthorizationBytes bytes")
        }
        mutex.withLock {
            if (id in entries) throw EncryptedUploadV2MaterialRegistryException("material ID is already registered")
            entries[id] = Entry(UUID.randomUUID(), material)
        }
    }

    suspend fun preparedMaterial(id: String): EncryptedUploadV2PreparedMaterial {
        val entry = requiredEntry(id)
        return EncryptedUploadV2PreparedMaterial(
            entry.material.authorization,
            sha256(entry.material.authorization),
            EncryptedUploadV2MaterialLease(entry.registrationId),
        )
    }

    suspend fun stagingRequest(
        id: String,
        lease: EncryptedUploadV2MaterialLease,
        evidence: EncryptedUploadV2TransferEvidence,
    ): Request {
        validateEvidence(evidence)
        val entry = requiredEntry(id, lease)
        val request = entry.material.stagingRequest(evidence)
        requireCurrent(id, entry.registrationId)
        val contentLength = request.body?.contentLength() ?: 0
        if (request.url.scheme.lowercase() != "https" || request.method.uppercase() != "PUT" || contentLength != 0L) {
            throw EncryptedUploadV2MaterialRegistryException(
                "staging request must be an HTTPS PUT with an empty template body",
            )
        }
        return request
    }

    suspend fun submitManifest(
        id: String,
        lease: EncryptedUploadV2MaterialLease,
        manifest: ByteArray,
        evidence: EncryptedUploadV2TransferEvidence,
    ) {
        validateEvidence(evidence)
        if (manifest.size != ManifestBytes ||
            evidence.manifestLength.toInt() != ManifestBytes ||
            !sha256(manifest).contentEquals(evidence.manifestSha256)
        ) {
            throw EncryptedUploadV2MaterialRegistryException("manifest evidence is invalid")
        }
        val entry = requiredEntry(id, lease)
        entry.material.submitManifest(manifest.copyOf(), evidence)
        requireCurrent(id, entry.registrationId)
    }

    suspend fun finalizeAndReceiveReceipt(
        id: String,
        lease: EncryptedUploadV2MaterialLease,
        evidence: EncryptedUploadV2TransferEvidence,
    ): EncryptedUploadV2AcceptedReceipt {
        validateEvidence(evidence)
        val entry = requiredEntry(id, lease)
        entry.material.finalize(evidence)
        requireCurrent(id, entry.registrationId)
        val receipt = entry.material.completionReceipt(evidence)
        requireCurrent(id, entry.registrationId)
        if (receipt.size != ReceiptBytes) {
            throw EncryptedUploadV2MaterialRegistryException("receipt must be exactly $ReceiptBytes bytes")
        }
        return EncryptedUploadV2AcceptedReceipt(receipt, sha256(receipt))
    }

    suspend fun terminate(id: String, outcome: EncryptedUploadV2TerminalOutcome) {
        val entry = mutex.withLock { entries.remove(id) } ?: return
        if (outcome != EncryptedUploadV2TerminalOutcome.Completed) entry.material.cancelOnce()
    }

    suspend fun terminate(
        id: String,
        lease: EncryptedUploadV2MaterialLease,
        outcome: EncryptedUploadV2TerminalOutcome,
    ) {
        val entry = mutex.withLock {
            val value = entries[id]
                ?.takeIf { it.registrationId == lease.registrationId }
                ?: throw EncryptedUploadV2MaterialRegistryException("material lease is missing or stale")
            entries.remove(id)
            value
        }
        if (outcome != EncryptedUploadV2TerminalOutcome.Completed) entry.material.cancelOnce()
    }

    suspend fun contains(id: String): Boolean = mutex.withLock { id in entries }

    private suspend fun requiredEntry(id: String): Entry = mutex.withLock {
        entries[id] ?: throw EncryptedUploadV2MaterialRegistryException("material is not registered")
    }

    private suspend fun requiredEntry(id: String, lease: EncryptedUploadV2MaterialLease): Entry = mutex.withLock {
        entries[id]
            ?.takeIf { it.registrationId == lease.registrationId }
            ?: throw EncryptedUploadV2MaterialRegistryException("material lease is missing or stale")
    }

    private suspend fun requireCurrent(id: String, registrationId: UUID) {
        if (mutex.withLock { entries[id]?.registrationId } != registrationId) {
            throw EncryptedUploadV2MaterialRegistryException("material callback completed after terminal cleanup")
        }
    }

    private fun validateEvidence(value: EncryptedUploadV2TransferEvidence) {
        if (value.ciphertextLength == 0uL ||
            value.ciphertextSha256.size != DigestBytes ||
            value.manifestLength.toInt() != ManifestBytes ||
            value.manifestSha256.size != DigestBytes ||
            value.blockCount == 0u
        ) {
            throw EncryptedUploadV2MaterialRegistryException("transfer evidence is invalid")
        }
    }

    private fun requireMaterialId(value: String) {
        if (value.isEmpty() || value.encodeToByteArray().size > 128 || value.any(Char::isWhitespace)) {
            throw EncryptedUploadV2MaterialRegistryException("material ID is invalid")
        }
    }

    private fun sha256(value: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(value)

    private companion object {
        const val AuthorizationBytes = 408
        const val ManifestBytes = 580
        const val ReceiptBytes = 336
        const val DigestBytes = 32
    }
}
