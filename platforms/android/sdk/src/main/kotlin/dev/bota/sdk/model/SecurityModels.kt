package dev.bota.sdk.model

public class ProvisioningMaterialRequest(
    public val serialNumber: String,
    nonce: ByteArray,
    devicePublicKey: ByteArray,
) {
    private val storedNonce: ByteArray = nonce.copyOf()
    private val storedDevicePublicKey: ByteArray = devicePublicKey.copyOf()

    public val nonce: ByteArray get() = storedNonce.copyOf()
    public val devicePublicKey: ByteArray get() = storedDevicePublicKey.copyOf()
}

public class ProvisioningMaterial(
    apiEndpoint: ByteArray,
    deviceToken: ByteArray,
    public val mtu: ULong,
) {
    private val storedApiEndpoint: ByteArray = apiEndpoint.copyOf()
    private val storedDeviceToken: ByteArray = deviceToken.copyOf()

    public val apiEndpoint: ByteArray get() = storedApiEndpoint.copyOf()
    public val deviceToken: ByteArray get() = storedDeviceToken.copyOf()
}

public enum class ProvisioningFailure(public val wireValue: String) {
    InvalidToken("invalid_token"),
    StorageError("storage_error"),
    ChunkError("chunk_error"),
    AlreadyPaired("already_paired"),
    Unknown("unknown"),
}

public data class DeprovisionResult(
    public val success: Boolean,
    public val error: ProvisioningFailure? = null,
)

public class FactoryResetGrantRequest(
    public val serialNumber: String,
    nonce: ByteArray,
    public val commandId: String,
    public val bindingGeneration: ULong,
) {
    private val storedNonce: ByteArray = nonce.copyOf()
    public val nonce: ByteArray get() = storedNonce.copyOf()
}

public data class FactoryResetPersistenceResult(
    public val localRecordingsDeleted: UShort,
) {
    private data class Metadata(
        val commandId: String,
        val bindingGeneration: ULong,
    )

    private var metadata: Metadata? = null

    public constructor(
        commandId: String,
        bindingGeneration: ULong,
        localRecordingsDeleted: UShort,
    ) : this(localRecordingsDeleted) {
        metadata = Metadata(commandId, bindingGeneration)
    }

    public val commandId: String
        get() = requireMetadata().commandId

    public val bindingGeneration: ULong
        get() = requireMetadata().bindingGeneration

    private fun requireMetadata(): Metadata = checkNotNull(metadata) {
        "factory-reset persistence metadata is unavailable"
    }
}

public data class FactoryResetCompletion(
    public val commandId: String,
    public val bindingGeneration: ULong,
)
