package dev.bota.sdk.internal.core

internal object EncryptedUploadV2Protocol {
    object Kind {
        const val DecodeCapability = 0x0520
        const val DecodeSignedBlob = 0x0521
        const val DecodeTransferOrStatus = 0x0522
    }

    object Field {
        const val RecordingUuid = 13
        const val Sequence = 38
        const val Offset = 39
        const val ProtocolVariant = 61
        const val Flags = 69
        const val MessageType = 127
        const val TransportSessionId = 128
        const val RecordingGeneration = 129
        const val CiphertextLength = 130
        const val PlaintextLength = 131
        const val CapabilityFlags = 137
        const val ManifestSha256 = 142
        const val PrefixSha256 = 143
        const val CiphertextSha256 = 144
        const val BodyLength = 150
        const val DetailCode = 155
        const val AuthorizationSha256 = 161
        const val ReceiptSha256 = 162
    }
}
