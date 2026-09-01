package dev.bota.sdk.internal.host

internal interface JournalStore {
    suspend fun read(name: String): ByteArray?
    suspend fun write(name: String, value: ByteArray)
    suspend fun delete(name: String)
}

internal object HostFieldId {
    const val SerialNumber: Int = 3
    const val PeripheralId: Int = 4
    const val Name: Int = 5
    const val AdvertisedAddress: Int = 6
    const val Rssi: Int = 7
    const val MaterialId: Int = 12
    const val SinkId: Int = 14
    const val UploadId: Int = 16
    const val DownloadId: Int = 21
    const val CommandId: Int = 22
    const val GrantId: Int = 23
    const val ResultCode: Int = 24
    const val DeletedRecordingCount: Int = 25
    const val Checkpoint: Int = 28
    const val Key: Int = 29
    const val Value: Int = 30
    const val Payload: Int = 33
    const val CompletedUnits: Int = 36
    const val ExpectedCrc32: Int = 37
    const val Sequence: Int = 38
    const val Offset: Int = 39
    const val MaximumLength: Int = 40
    const val Nonce: Int = 41
    const val DevicePublicKey: Int = 42
    const val DurableUnits: Int = 54
    const val ApiEndpoint: Int = 55
    const val DeviceToken: Int = 56
    const val Mtu: Int = 57
    const val Encrypted: Int = 90
    const val EphemeralPublicKey: Int = 93
    const val Salt: Int = 94
    const val TotalUnits: Int = 15
    const val ExpectedChunks: Int = 125
    const val UploadedChunks: Int = 126
}

internal fun validOpaqueId(value: String): String {
    if (value.isEmpty() || value.encodeToByteArray().size > 128 || value.contains('/') || value.contains('\\')) {
        throw NativeHostException(422, "invalid opaque resource ID")
    }
    return value
}
