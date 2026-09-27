package dev.bota.sdk

import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Request

public class EncryptedUploadV2Capabilities(
    public val flags: UInt,
    public val maximumSignedBlobBytes: UShort,
    public val maximumManifestBytes: UShort,
    public val maximumDataPayloadBytes: UShort,
    public val maximumWindowPackets: UShort,
    public val durableCheckpointIntervalBlocks: UInt,
    public val maximumMissingSequences: UShort,
)

public class EncryptedUploadV2CapabilitySnapshot(
    rawValue: ByteArray,
    sha256: ByteArray,
    public val capabilities: EncryptedUploadV2Capabilities,
) {
    private val storedRawValue: ByteArray = rawValue.copyOf()
    private val storedSha256: ByteArray = sha256.copyOf()
    public val rawValue: ByteArray get() = storedRawValue.copyOf()
    public val sha256: ByteArray get() = storedSha256.copyOf()
}

public class EncryptedUploadV2Recording(
    public val uuid: String,
    public val generation: UInt,
    public val ciphertextLength: ULong,
    ciphertextSha256: ByteArray,
    public val startedAtMs: ULong = 0u,
    public val durationMs: ULong = 0u,
    public val plaintextLength: ULong = 0u,
    public val storageFormat: UByte = 3u,
) {
    private val storedCiphertextSha256: ByteArray = ciphertextSha256.copyOf()
    public val ciphertextSha256: ByteArray get() = storedCiphertextSha256.copyOf()
}

public class EncryptedUploadV2Checkpoint(
    public val uploadSessionId: UUID,
    public val ownerRevision: UInt,
    public val revision: UInt,
    public val nextCiphertextOffset: ULong,
    prefixSha256: ByteArray,
    public val highestContiguousSequence: UInt?,
    public val transportSessionId: ULong,
    public val sinkId: String,
    public val windowPackets: UShort,
    public val dataPayloadBytes: UShort,
    public val ciphertextLength: ULong? = null,
    ciphertextSha256: ByteArray? = null,
    public val checkpointIntervalBlocks: UInt? = null,
) {
    private val storedPrefixSha256: ByteArray = prefixSha256.copyOf()
    public val prefixSha256: ByteArray get() = storedPrefixSha256.copyOf()
    private val storedCiphertextSha256 = ciphertextSha256?.copyOf()
    public val ciphertextSha256: ByteArray? get() = storedCiphertextSha256?.copyOf()
}

public class EncryptedUploadV2ProviderContext(
    public val recording: EncryptedUploadV2Recording,
    public val capability: EncryptedUploadV2CapabilitySnapshot,
    public val checkpoint: EncryptedUploadV2Checkpoint?,
    public val readAuthNonce: suspend () -> ByteArray = { error("auth nonce read unavailable") },
)

public enum class EncryptedUploadV2SecurityPolicy {
    LegacyAllowed,
    V2Preferred,
    V2Required,
}

public class EncryptedUploadV2TransferEvidence(
    public val ciphertextLength: ULong,
    ciphertextSha256: ByteArray,
    public val manifestLength: UShort,
    manifestSha256: ByteArray,
    public val blockCount: UInt,
) {
    private val storedCiphertextSha256: ByteArray = ciphertextSha256.copyOf()
    private val storedManifestSha256: ByteArray = manifestSha256.copyOf()
    public val ciphertextSha256: ByteArray get() = storedCiphertextSha256.copyOf()
    public val manifestSha256: ByteArray get() = storedManifestSha256.copyOf()
}

public class EncryptedUploadV2Material(
    public val materialId: String,
    public val recordingId: String,
    public val uploadSessionId: UUID,
    public val ownerRevision: UInt,
    public val policy: EncryptedUploadV2SecurityPolicy,
    authorization: ByteArray,
    internal val stagingRequest: suspend (EncryptedUploadV2TransferEvidence) -> Request,
    internal val submitManifest: suspend (ByteArray, EncryptedUploadV2TransferEvidence) -> Unit,
    internal val finalize: suspend (EncryptedUploadV2TransferEvidence) -> Unit,
    internal val completionReceipt: suspend (EncryptedUploadV2TransferEvidence) -> ByteArray,
    private val cancel: suspend () -> Unit = {},
    public val uploadContext: EncryptedUploadV2ContextProvider? = null,
    internal val shouldUploadCiphertext: suspend (EncryptedUploadV2TransferEvidence) -> Boolean = { true },
) {
    private val storedAuthorization: ByteArray = authorization.copyOf()
    internal val authorization: ByteArray get() = storedAuthorization.copyOf()
    private val cancelled = AtomicBoolean(false)

    internal suspend fun cancelOnce() {
        if (cancelled.compareAndSet(false, true)) cancel()
    }

    public suspend fun cancelPreparation(): Unit = cancelOnce()

    override fun toString(): String = "EncryptedUploadV2Material(<redacted>)"
}

public class EncryptedUploadV2ContextExchange(
    challenge: ByteArray,
    internal val exchangeProof: suspend (ByteArray) -> ByteArray,
) {
    private val storedChallenge = challenge.copyOf()
    public val challenge: ByteArray get() = storedChallenge.copyOf()
    override fun toString(): String = "EncryptedUploadV2ContextExchange(<redacted>)"
}

public typealias EncryptedUploadV2ContextProvider = suspend (ByteArray) -> EncryptedUploadV2ContextExchange

public sealed interface PendingRecording {
    public data class Legacy(public val recording: dev.bota.sdk.model.DeviceRecording) : PendingRecording
    public data class EncryptedV2(public val recording: EncryptedUploadV2Recording) : PendingRecording
}

public fun interface EncryptedUploadV2ProfileProvider {
    public suspend fun select(context: EncryptedUploadV2ProviderContext): EncryptedUploadV2Material
}
