package dev.bota.sdk.internal.core

import java.util.UUID
import java.nio.ByteBuffer

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

internal data class EncryptedUploadV2CapabilitiesValue(
    val flags: UInt,
    val maximumSignedBlobBytes: UShort,
    val maximumManifestBytes: UShort,
    val maximumDataPayloadBytes: UShort,
    val maximumWindowPackets: UShort,
    val durableCheckpointIntervalBlocks: UInt,
    val maximumMissingSequences: UShort,
)

internal data class EncryptedUploadV2SignedBlobResult(
    val kind: UByte,
    val writeId: UInt,
    val result: UShort,
)

internal data class EncryptedUploadV2StartRequest(
    val transportSessionId: ULong,
    val uploadSessionId: UUID,
    val recordingUuid: String,
    val recordingGeneration: UInt,
    val authorizationSha256: ByteArray,
    val expectedCiphertextLength: ULong,
    val expectedCiphertextSha256: ByteArray,
    val expectedCheckpointIntervalBlocks: UInt,
    val checkpointRevision: UInt,
    val nextCiphertextOffset: ULong,
    val prefixSha256: ByteArray,
    val windowPackets: UShort,
    val dataPayloadBytes: UShort,
)

internal data class EncryptedUploadV2ResumeRequest(
    val transportSessionId: ULong,
    val uploadSessionId: UUID,
    val recordingUuid: String,
    val recordingGeneration: UInt,
    val checkpointRevision: UInt,
    val nextCiphertextOffset: ULong,
    val prefixSha256: ByteArray,
    val windowPackets: UShort,
    val dataPayloadBytes: UShort,
)

internal data class EncryptedUploadV2StartAcknowledgement(
    val transportSessionId: ULong,
    val uploadSessionId: UUID,
    val recordingUuid: String,
    val recordingGeneration: UInt,
    val ciphertextLength: ULong,
    val ciphertextSha256: ByteArray,
    val windowPackets: UShort,
    val dataPayloadBytes: UShort,
    val checkpointIntervalBlocks: UInt,
    val checkpointRevision: UInt,
    val nextCiphertextOffset: ULong,
    val prefixSha256: ByteArray,
)

internal data class EncryptedUploadV2ResumeValue(
    val transportSessionId: ULong,
    val uploadSessionId: UUID,
    val recordingUuid: String,
    val recordingGeneration: UInt,
    val checkpointRevision: UInt,
    val nextCiphertextOffset: ULong,
    val prefixSha256: ByteArray,
    val windowPackets: UShort,
    val dataPayloadBytes: UShort,
)

internal data class EncryptedUploadV2ResumeRejection(
    val transportSessionId: ULong,
    val reason: UShort,
    val checkpointRevision: UInt,
    val nextCiphertextOffset: ULong,
    val prefixSha256: ByteArray,
)

internal data class EncryptedUploadV2TransferErrorValue(
    val transportSessionId: ULong,
    val result: UShort,
    val failedMessageType: UByte,
    val checkpointRevision: UInt,
)

internal sealed interface EncryptedUploadV2TransferControlValue {
    data class StartAccepted(val value: EncryptedUploadV2StartAcknowledgement) :
        EncryptedUploadV2TransferControlValue
    data class ResumeAccepted(val value: EncryptedUploadV2ResumeValue) :
        EncryptedUploadV2TransferControlValue
    data class ResumeRejected(val value: EncryptedUploadV2ResumeRejection) :
        EncryptedUploadV2TransferControlValue
    data class Error(val value: EncryptedUploadV2TransferErrorValue) :
        EncryptedUploadV2TransferControlValue
}

internal data class EncryptedUploadV2DataValue(
    val transportSessionId: ULong,
    val sequence: UInt,
    val ciphertextOffset: ULong,
    val bytes: ByteArray,
)

internal data class EncryptedUploadV2WindowEndValue(
    val transportSessionId: ULong,
    val windowIndex: UInt,
    val firstSequence: UInt,
    val lastSequence: UInt,
    val nextCiphertextOffset: ULong,
    val prefixSha256: ByteArray,
    val checkpointRevision: UInt,
)

internal data class EncryptedUploadV2ManifestChunkValue(
    val transportSessionId: ULong,
    val totalManifestLength: UShort,
    val chunkOffset: UShort,
    val manifestSha256: ByteArray,
    val bytes: ByteArray,
)

internal data class EncryptedUploadV2EofValue(
    val transportSessionId: ULong,
    val finalSequence: UInt,
    val blockCount: UInt,
    val ciphertextLength: ULong,
    val ciphertextSha256: ByteArray,
    val manifestSha256: ByteArray,
)

internal sealed interface EncryptedUploadV2TransferPayload {
    data class Data(val value: EncryptedUploadV2DataValue) : EncryptedUploadV2TransferPayload
    data class WindowEnd(val value: EncryptedUploadV2WindowEndValue) : EncryptedUploadV2TransferPayload
    data class ManifestChunk(val value: EncryptedUploadV2ManifestChunkValue) : EncryptedUploadV2TransferPayload
    data class Eof(val value: EncryptedUploadV2EofValue) : EncryptedUploadV2TransferPayload
    data class Error(val value: EncryptedUploadV2TransferErrorValue) : EncryptedUploadV2TransferPayload
}

internal data class EncryptedUploadV2CommandRequest(
    val serialNumber: String,
    val recordingUuid: String,
    val recordingGeneration: UInt,
    val storageFormat: UByte,
    val uploadSessionId: UUID,
    val ownerRevision: UInt,
    val transportSessionId: ULong,
    val materialId: String,
    val sinkId: String,
    val securityPolicy: ULong,
    val capabilities: EncryptedUploadV2CapabilitiesValue,
    val windowPackets: UShort,
    val dataPayloadBytes: UShort,
    val ciphertextLength: ULong,
    val ciphertextSha256: ByteArray,
)

internal fun UUID.toNetworkBytes(): ByteArray = ByteBuffer.allocate(16)
    .putLong(mostSignificantBits)
    .putLong(leastSignificantBits)
    .array()
