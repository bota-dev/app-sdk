package dev.bota.sdk.internal.core

internal data class EncryptedUploadV2ContractValue(
    val kind: UByte,
    val messageType: UByte? = null,
    val flags: UInt? = null,
    val transportSessionId: ULong? = null,
    val recordingUuid: String? = null,
    val recordingGeneration: UInt? = null,
    val sequence: UInt? = null,
    val offset: ULong? = null,
    val length: ULong? = null,
    val result: UShort? = null,
    val authorizationSha256: ByteArray? = null,
    val ciphertextSha256: ByteArray? = null,
    val prefixSha256: ByteArray? = null,
    val manifestSha256: ByteArray? = null,
    val receiptSha256: ByteArray? = null,
)
