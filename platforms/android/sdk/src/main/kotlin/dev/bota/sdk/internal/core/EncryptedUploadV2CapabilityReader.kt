package dev.bota.sdk.internal.core

import dev.bota.sdk.EncryptedUploadV2Capabilities
import dev.bota.sdk.EncryptedUploadV2CapabilitySnapshot
import dev.bota.sdk.internal.bluetooth.BotaBluetoothUUIDs
import java.security.MessageDigest
import java.util.UUID

internal class EncryptedUploadV2CapabilityReader(
    private val read: suspend (String, UUID, UUID) -> ByteArray,
    private val decode: (ByteArray) -> EncryptedUploadV2CapabilitiesValue,
) {
    suspend fun readFresh(peripheralId: String): EncryptedUploadV2CapabilitySnapshot {
        val raw = read(
            peripheralId,
            BotaBluetoothUUIDs.StorageService,
            BotaBluetoothUUIDs.TransferCapabilitiesV2,
        )
        val value = decode(raw)
        return EncryptedUploadV2CapabilitySnapshot(
            raw,
            MessageDigest.getInstance("SHA-256").digest(raw),
            EncryptedUploadV2Capabilities(
                value.flags,
                value.maximumSignedBlobBytes,
                value.maximumManifestBytes,
                value.maximumDataPayloadBytes,
                value.maximumWindowPackets,
                value.durableCheckpointIntervalBlocks,
                value.maximumMissingSequences,
            ),
        )
    }
}
