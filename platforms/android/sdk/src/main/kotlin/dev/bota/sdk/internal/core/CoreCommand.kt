package dev.bota.sdk.internal.core

import dev.bota.sdk.internal.jni.NativePacket
import java.util.UUID

internal sealed interface CoreField {
    val id: Int

    data class Unsigned(override val id: Int, val value: ULong) : CoreField
    data class Signed(override val id: Int, val value: Long) : CoreField
    data class BooleanValue(override val id: Int, val value: Boolean) : CoreField
    data class Text(override val id: Int, val value: String) : CoreField
    class Bytes(override val id: Int, value: ByteArray) : CoreField {
        val value: ByteArray = value.copyOf()

        override fun equals(other: Any?): Boolean =
            other is Bytes && id == other.id && value.contentEquals(other.value)

        override fun hashCode(): Int = 31 * id + value.contentHashCode()
    }
}

internal data class CoreCapabilities(val bits: ULong) {
    operator fun plus(other: CoreCapabilities): CoreCapabilities = CoreCapabilities(bits or other.bits)

    companion object {
        val Bluetooth = CoreCapabilities(1uL shl 0)
        val Timer = CoreCapabilities(1uL shl 1)
        val Persistence = CoreCapabilities(1uL shl 2)
        val SecureStorage = CoreCapabilities(1uL shl 3)
        val NetworkTransfer = CoreCapabilities(1uL shl 4)
        val Progress = CoreCapabilities(1uL shl 5)
        val HostMaterial = CoreCapabilities(1uL shl 6)
        val RecordingSink = CoreCapabilities(1uL shl 7)
        val FirmwareBlob = CoreCapabilities(1uL shl 8)

        fun fromNames(names: List<String>): CoreCapabilities = names.fold(CoreCapabilities(0u)) { value, name ->
            value + when (name) {
                "ble" -> Bluetooth
                "timer" -> Timer
                "persistence" -> Persistence
                "secure_storage" -> SecureStorage
                "network_transfer" -> NetworkTransfer
                "progress" -> Progress
                "host_material" -> HostMaterial
                "recording_sink" -> RecordingSink
                "firmware_blob" -> FirmwareBlob
                else -> throw IllegalArgumentException("unknown capability $name")
            }
        }
    }
}

internal data class CoreCancellationId(val high: ULong, val low: ULong) {
    constructor(id: UUID) : this(id.mostSignificantBits.toULong(), id.leastSignificantBits.toULong())
}

internal data class CoreCommand(
    val kind: Int,
    val cancellationId: UUID,
    val fields: List<CoreField>,
) {
    val packet: NativePacket
        get() = fields.toNativePacket(kind, cancellationId = CoreCancellationId(cancellationId))

    companion object {
        fun discoverDevices(
            timeoutMilliseconds: ULong,
            allowDuplicates: Boolean,
            cancellationId: UUID = UUID.randomUUID(),
        ) = CoreCommand(
            0x0101,
            cancellationId,
            listOf(CoreField.Unsigned(1, timeoutMilliseconds), CoreField.BooleanValue(2, allowDuplicates)),
        )

        fun connect(
            serialNumber: String,
            peripheralId: String,
            name: String?,
            advertisedAddress: String?,
            rssi: Int,
            cancellationId: UUID = UUID.randomUUID(),
        ) = CoreCommand(
            0x0102,
            cancellationId,
            buildList {
                add(CoreField.Text(3, serialNumber))
                add(CoreField.Text(4, peripheralId))
                add(CoreField.Signed(7, rssi.toLong()))
                name?.let { add(CoreField.Text(5, it)) }
                advertisedAddress?.let { add(CoreField.Text(6, it)) }
            },
        )

        fun connectSelected(
            peripheralId: String,
            name: String?,
            advertisedAddress: String?,
            rssi: Int,
            cancellationId: UUID = UUID.randomUUID(),
        ) = CoreCommand(
            0x0102,
            cancellationId,
            buildList {
                add(CoreField.Text(4, peripheralId))
                add(CoreField.Signed(7, rssi.toLong()))
                name?.let { add(CoreField.Text(5, it)) }
                advertisedAddress?.let { add(CoreField.Text(6, it)) }
            },
        )

        fun reconnect(
            serialNumber: String,
            storedPeripheralId: String? = null,
            advertisedAddress: String? = null,
            storedName: String? = null,
            scanTimeoutMilliseconds: ULong = 10_000u,
            connectionTimeoutMilliseconds: ULong = 10_000u,
            cancellationId: UUID = UUID.randomUUID(),
        ) = CoreCommand(
            0x0103,
            cancellationId,
            buildList {
                add(CoreField.Text(3, serialNumber))
                add(CoreField.Unsigned(10, scanTimeoutMilliseconds))
                add(CoreField.Unsigned(11, connectionTimeoutMilliseconds))
                storedPeripheralId?.let { add(CoreField.Text(8, it)) }
                advertisedAddress?.let { add(CoreField.Text(6, it)) }
                storedName?.let { add(CoreField.Text(9, it)) }
            },
        )

        fun provision(serialNumber: String, materialId: String, cancellationId: UUID = UUID.randomUUID()) =
            command(0x0104, cancellationId, CoreField.Text(3, serialNumber), CoreField.Text(12, materialId))

        fun transferRecording(
            serialNumber: String,
            recordingUuid: String,
            sinkId: String,
            totalUnits: ULong,
            confirmOnCompletion: Boolean = true,
            cancellationId: UUID = UUID.randomUUID(),
        ) = command(
            0x0105,
            cancellationId,
            CoreField.Text(3, serialNumber),
            CoreField.Text(13, recordingUuid),
            CoreField.Text(14, sinkId),
            CoreField.Unsigned(15, totalUnits),
            CoreField.BooleanValue(124, confirmOnCompletion),
        )

        fun uploadRecording(
            serialNumber: String,
            recordingUuid: String,
            uploadId: String,
            destinationId: String,
            cancellationId: UUID = UUID.randomUUID(),
        ) = command(
            0x0106,
            cancellationId,
            CoreField.Text(3, serialNumber),
            CoreField.Text(13, recordingUuid),
            CoreField.Text(16, uploadId),
            CoreField.Text(17, destinationId),
        )

        fun updateFirmware(
            serialNumber: String,
            version: String,
            sizeBytes: UInt,
            crc32: UInt,
            downloadId: ULong,
            cancellationId: UUID = UUID.randomUUID(),
        ) = command(
            0x0107,
            cancellationId,
            CoreField.Text(3, serialNumber),
            CoreField.Text(18, version),
            CoreField.Unsigned(19, sizeBytes.toULong()),
            CoreField.Unsigned(20, crc32.toULong()),
            CoreField.Unsigned(21, downloadId),
        )

        fun readDeviceLogs(serialNumber: String, cancellationId: UUID = UUID.randomUUID()) =
            command(0x0108, cancellationId, CoreField.Text(3, serialNumber))

        fun factoryReset(
            serialNumber: String,
            commandId: String,
            grantId: String,
            cancellationId: UUID = UUID.randomUUID(),
        ) = command(
            0x0109,
            cancellationId,
            CoreField.Text(3, serialNumber),
            CoreField.Text(22, commandId),
            CoreField.Text(23, grantId),
        )

        fun resumeFactoryReset(
            serialNumber: String,
            commandId: String,
            resultCode: UByte,
            deletedRecordingCount: UShort,
            cancellationId: UUID = UUID.randomUUID(),
        ) = command(
            0x010a,
            cancellationId,
            CoreField.Text(3, serialNumber),
            CoreField.Text(22, commandId),
            CoreField.Unsigned(24, resultCode.toULong()),
            CoreField.Unsigned(25, deletedRecordingCount.toULong()),
        )

        fun resumeUnjournaledFactoryReset(
            serialNumber: String,
            commandId: String,
            cancellationId: UUID = UUID.randomUUID(),
        ) = command(
            0x010a,
            cancellationId,
            CoreField.Text(3, serialNumber),
            CoreField.Text(22, commandId),
        )

        fun fixtureNamed(name: String): CoreCommand? {
            val serial = "EVFXXW67KP"
            val recording = "00112233445566778899aabbccddeeff"
            return when (name) {
                "discover_devices" -> discoverDevices(1u, false)
                "connect" -> connect(serial, "peripheral", null, null, -40)
                "reconnect" -> reconnect(serial)
                "provision" -> provision(serial, "material")
                "transfer_recording" -> transferRecording(serial, recording, "sink", 1u)
                "upload_recording" -> uploadRecording(serial, recording, "upload", "destination")
                "update_firmware" -> updateFirmware(serial, "1.0.0", 1u, 1u, 1u)
                "read_device_logs" -> readDeviceLogs(serial)
                "factory_reset" -> factoryReset(serial, "command", "grant")
                "resume_factory_reset" -> resumeFactoryReset(serial, "command", 0u, 0u)
                else -> null
            }
        }

        private fun command(kind: Int, cancellationId: UUID, vararg fields: CoreField) =
            CoreCommand(kind, cancellationId, fields.toList())
    }
}

internal fun List<CoreField>.toNativePacket(
    kind: Int,
    operation: Int = 0,
    requestId: ULong = 0u,
    cancellationId: CoreCancellationId = CoreCancellationId(0u, 0u),
): NativePacket {
    val types = IntArray(size)
    val unsigned = LongArray(size)
    val signed = LongArray(size)
    val data = arrayOfNulls<Any>(size)
    forEachIndexed { index, field ->
        when (field) {
            is CoreField.Unsigned -> {
                types[index] = NativePacket.FIELD_TYPE_UNSIGNED
                unsigned[index] = field.value.toLong()
            }
            is CoreField.Signed -> {
                types[index] = NativePacket.FIELD_TYPE_SIGNED
                signed[index] = field.value
            }
            is CoreField.BooleanValue -> {
                types[index] = NativePacket.FIELD_TYPE_BOOL
                unsigned[index] = if (field.value) 1 else 0
            }
            is CoreField.Text -> {
                types[index] = NativePacket.FIELD_TYPE_UTF8
                data[index] = field.value.encodeToByteArray()
            }
            is CoreField.Bytes -> {
                types[index] = NativePacket.FIELD_TYPE_BYTES
                data[index] = field.value.copyOf()
            }
        }
    }
    return NativePacket(
        kind = kind,
        operation = operation,
        requestIdBits = requestId.toLong(),
        cancellationHighBits = cancellationId.high.toLong(),
        cancellationLowBits = cancellationId.low.toLong(),
        fieldIds = map(CoreField::id).toIntArray(),
        fieldTypes = types,
        unsignedValues = unsigned,
        signedValues = signed,
        dataValues = data,
    )
}
