package dev.bota.sdk.internal.jni

import java.nio.ByteBuffer

internal class NativePacket(
    @JvmField val kind: Int,
    @JvmField val operation: Int = 0,
    @JvmField val requestIdBits: Long = 0,
    @JvmField val cancellationHighBits: Long = 0,
    @JvmField val cancellationLowBits: Long = 0,
    @JvmField val fieldIds: IntArray = intArrayOf(),
    @JvmField val fieldTypes: IntArray = intArrayOf(),
    @JvmField val unsignedValues: LongArray = longArrayOf(),
    @JvmField val signedValues: LongArray = longArrayOf(),
    @JvmField val dataValues: Array<Any?> = emptyArray(),
) {
    init {
        val fieldCount = fieldIds.size
        require(fieldTypes.size == fieldCount) { "fieldTypes must match fieldIds" }
        require(unsignedValues.size == fieldCount) { "unsignedValues must match fieldIds" }
        require(signedValues.size == fieldCount) { "signedValues must match fieldIds" }
        require(dataValues.size == fieldCount) { "dataValues must match fieldIds" }

        fieldTypes.forEachIndexed { index, type ->
            require(type in FIELD_TYPE_UNSIGNED..FIELD_TYPE_BYTES) { "unknown field type $type" }
            val data = dataValues[index]
            if (type == FIELD_TYPE_UTF8 || type == FIELD_TYPE_BYTES) {
                require(data is ByteArray || data is ByteBuffer && data.isDirect) {
                    "binary fields require ByteArray or a direct ByteBuffer"
                }
            } else {
                require(data == null) { "scalar fields cannot carry binary data" }
            }
        }
    }

    val requestId: ULong
        get() = requestIdBits.toULong()

    val cancellationHigh: ULong
        get() = cancellationHighBits.toULong()

    val cancellationLow: ULong
        get() = cancellationLowBits.toULong()

    fun requiredUnsigned(fieldId: Int): ULong {
        val index = fieldIndex(fieldId, FIELD_TYPE_UNSIGNED)
        return unsignedValues[index].toULong()
    }

    fun requiredSigned(fieldId: Int): Long = signedValues[fieldIndex(fieldId, FIELD_TYPE_SIGNED)]

    fun requiredBoolean(fieldId: Int): Boolean =
        unsignedValues[fieldIndex(fieldId, FIELD_TYPE_BOOL)] != 0L

    fun requiredText(fieldId: Int): String =
        requiredData(fieldId, FIELD_TYPE_UTF8).decodeToString(throwOnInvalidSequence = true)

    fun requiredBytes(fieldId: Int): ByteArray {
        return requiredData(fieldId, FIELD_TYPE_BYTES)
    }

    fun unsigneds(fieldId: Int): List<ULong> = fieldIndices(fieldId, FIELD_TYPE_UNSIGNED).map {
        unsignedValues[it].toULong()
    }

    fun signed(fieldId: Int): Long? = fieldIndices(fieldId, FIELD_TYPE_SIGNED).firstOrNull()?.let {
        signedValues[it]
    }

    fun booleans(fieldId: Int): List<Boolean> = fieldIndices(fieldId, FIELD_TYPE_BOOL).map {
        unsignedValues[it] != 0L
    }

    fun texts(fieldId: Int): List<String> = fieldIndices(fieldId, FIELD_TYPE_UTF8).map {
        dataAt(it).decodeToString(throwOnInvalidSequence = true)
    }

    fun bytes(fieldId: Int): ByteArray? = fieldIndices(fieldId, FIELD_TYPE_BYTES).firstOrNull()?.let(::dataAt)

    private fun requiredData(fieldId: Int, fieldType: Int): ByteArray {
        val index = fieldIndex(fieldId, fieldType)
        return dataAt(index)
    }

    private fun dataAt(index: Int): ByteArray {
        return when (val data = dataValues[index]) {
            is ByteArray -> data.copyOf()
            is ByteBuffer -> data.duplicate().let { buffer ->
                ByteArray(buffer.remaining()).also(buffer::get)
            }
            else -> error("missing binary data at field index $index")
        }
    }

    private fun fieldIndex(fieldId: Int, fieldType: Int): Int =
        fieldIndices(fieldId, fieldType).firstOrNull()
            ?: error("missing field $fieldId with type $fieldType")

    private fun fieldIndices(fieldId: Int, fieldType: Int): List<Int> =
        fieldIds.indices.filter { fieldIds[it] == fieldId && fieldTypes[it] == fieldType }

    internal companion object {
        const val FIELD_TYPE_UNSIGNED: Int = 1
        const val FIELD_TYPE_SIGNED: Int = 2
        const val FIELD_TYPE_BOOL: Int = 3
        const val FIELD_TYPE_UTF8: Int = 4
        const val FIELD_TYPE_BYTES: Int = 5
    }
}

internal class NativeCoreException(
    val code: Int,
    val operation: Int,
    val retryable: Boolean,
    val protocolStatus: Int,
    val detail: String,
) : IllegalStateException(detail)
