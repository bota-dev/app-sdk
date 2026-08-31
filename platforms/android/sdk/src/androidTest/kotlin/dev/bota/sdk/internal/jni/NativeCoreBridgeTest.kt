package dev.bota.sdk.internal.jni

import java.nio.ByteBuffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Test

internal class NativeCoreBridgeTest {
    private var bridge: NativeCoreBridge? = null

    @After
    fun tearDown() {
        bridge?.close()
    }

    @Test
    fun packagedLibrariesExposeAbiV1AndCloseTheEngineExactlyOnce() {
        NativeCoreBridge.resetTestCounters()
        val core = newBridge()

        assertEquals(1, NativeCoreBridge.abiVersion())
        core.close()
        core.close()

        assertArrayEquals(longArrayOf(1, 0, 0), NativeCoreBridge.testCounters())
        assertThrows(IllegalStateException::class.java) { core.poll() }
    }

    @Test
    fun codecsPreserveAllFieldRepresentationsAndEmbeddedZeroBytes() {
        NativeCoreBridge.resetTestCounters()
        val core = newBridge()
        val connectionSettings = packet(
            kind = PROTOCOL_ENCODE_CONNECTION_SETTINGS,
            fieldIds = intArrayOf(
                FIELD_ENABLED_WIFI,
                FIELD_ENABLED_CELLULAR,
                FIELD_CONNECTION_TYPE,
                FIELD_CELLULAR_IDLE_TIMEOUT,
                FIELD_WIFI_IDLE_TIMEOUT,
                FIELD_STREAMING_ENABLED,
                FIELD_STREAMING_FLUSH_INTERVAL,
                FIELD_HEARTBEAT_WIFI,
                FIELD_HEARTBEAT_CELLULAR,
                FIELD_DEVICE_MODEL,
            ),
            fieldTypes = intArrayOf(BOOL, BOOL, BYTES, SIGNED, SIGNED, BOOL, UNSIGNED, BOOL, BOOL, UNSIGNED),
            unsignedValues = longArrayOf(1, 0, 0, 0, 0, 0, 60, 1, 0, 1),
            signedValues = longArrayOf(0, 0, 0, -1, 0, 0, 0, 0, 0, 0),
            dataValues = arrayOf(null, null, byteArrayOf(1, 2, 3), null, null, null, null, null, null, null),
        )

        val encodedSettings = core.encode(connectionSettings)
        assertEquals(PROTOCOL_ENCODE_CONNECTION_SETTINGS, encodedSettings.kind)
        assertFalse(encodedSettings.requiredBytes(FIELD_VALUE).isEmpty())
        val decodedSettings = core.decode(
            packet(
                kind = PROTOCOL_DECODE_CONNECTION_SETTINGS,
                fieldIds = intArrayOf(FIELD_VALUE),
                fieldTypes = intArrayOf(BYTES),
                dataValues = arrayOf(encodedSettings.requiredBytes(FIELD_VALUE)),
            ),
        )
        assertEquals(60uL, decodedSettings.requiredUnsigned(FIELD_STREAMING_FLUSH_INTERVAL))
        assertEquals(-1L, decodedSettings.requiredSigned(FIELD_CELLULAR_IDLE_TIMEOUT))
        assertEquals(true, decodedSettings.requiredBoolean(FIELD_ENABLED_WIFI))

        val grant = core.encode(
            packet(
                kind = PROTOCOL_ENCODE_WIFI_GRANT,
                fieldIds = intArrayOf(FIELD_GRANT, FIELD_CAPACITY),
                fieldTypes = intArrayOf(UTF8, UNSIGNED),
                unsignedValues = longArrayOf(0, 64),
                dataValues = arrayOf("grant.test".encodeToByteArray(), null),
            ),
        )
        assertArrayEquals("grant.test".encodeToByteArray(), grant.requiredBytes(FIELD_VALUE))

        val logs = core.decode(
            packet(
                kind = PROTOCOL_DECODE_DEVICE_LOGS,
                fieldIds = intArrayOf(FIELD_VALUE),
                fieldTypes = intArrayOf(BYTES),
                dataValues = arrayOf(byteArrayOf(0, 0, 0) + "line\n".encodeToByteArray()),
            ),
        )
        assertEquals("line", logs.requiredText(FIELD_LOG_MESSAGE))

        val directPayload = ByteBuffer.allocateDirect(4).apply {
            put(byteArrayOf(0x00, 0xff.toByte(), 0x00, 0x7f))
            flip()
        }
        val firmware = core.encode(
            packet(
                kind = PROTOCOL_ENCODE_FIRMWARE_DATA,
                fieldIds = intArrayOf(FIELD_SEQUENCE, FIELD_PAYLOAD),
                fieldTypes = intArrayOf(UNSIGNED, BYTES),
                unsignedValues = longArrayOf(0x1234, 0),
                dataValues = arrayOf(null, directPayload),
            ),
        )
        assertArrayEquals(
            byteArrayOf(0x20, 0x34, 0x12, 0x00, 0xff.toByte(), 0x00, 0x7f),
            firmware.requiredBytes(FIELD_VALUE),
        )
        assertArrayEquals(longArrayOf(0, 5, 0), NativeCoreBridge.testCounters())
    }

    @Test
    fun pollingCopiesAndFreesOneRustOwnedPacket() {
        NativeCoreBridge.resetTestCounters()
        val core = newBridge()
        core.start(
            packet(
                kind = COMMAND_DISCOVER_DEVICES,
                cancellationHigh = 1,
                cancellationLow = 2,
                fieldIds = intArrayOf(FIELD_TIMEOUT_MS, FIELD_ALLOW_DUPLICATES),
                fieldTypes = intArrayOf(UNSIGNED, BOOL),
                unsignedValues = longArrayOf(5_000, 1),
            ),
            CAPABILITY_BLE or CAPABILITY_TIMER,
        )

        val effect = core.poll()
        assertNotNull(effect)
        requireNotNull(effect)
        assertEquals(NOTIFICATION_STARTED, effect.kind)
        assertEquals(4, effect.operation)
        assertArrayEquals(longArrayOf(0, 1, 0), NativeCoreBridge.testCounters())
    }

    @Test
    fun operationFailureCopiesAndFreesTheStructuredError() {
        NativeCoreBridge.resetTestCounters()
        val core = newBridge()

        val error = assertThrows(NativeCoreException::class.java) {
            core.cancel(7uL, 9uL)
        }

        assertEquals(ERROR_UNEXPECTED_EVENT, error.code)
        assertFalse(error.retryable)
        assertFalse(error.detail.isBlank())
        assertArrayEquals(longArrayOf(0, 0, 1), NativeCoreBridge.testCounters())
    }

    private fun newBridge(): NativeCoreBridge = NativeCoreBridge().also { bridge = it }

    private fun packet(
        kind: Int,
        operation: Int = 0,
        requestId: Long = 0,
        cancellationHigh: Long = 0,
        cancellationLow: Long = 0,
        fieldIds: IntArray = intArrayOf(),
        fieldTypes: IntArray = intArrayOf(),
        unsignedValues: LongArray = LongArray(fieldIds.size),
        signedValues: LongArray = LongArray(fieldIds.size),
        dataValues: Array<Any?> = arrayOfNulls(fieldIds.size),
    ): NativePacket = NativePacket(
        kind = kind,
        operation = operation,
        requestIdBits = requestId,
        cancellationHighBits = cancellationHigh,
        cancellationLowBits = cancellationLow,
        fieldIds = fieldIds,
        fieldTypes = fieldTypes,
        unsignedValues = unsignedValues,
        signedValues = signedValues,
        dataValues = dataValues,
    )

    private companion object {
        const val UNSIGNED = 1
        const val SIGNED = 2
        const val BOOL = 3
        const val UTF8 = 4
        const val BYTES = 5

        const val COMMAND_DISCOVER_DEVICES = 0x0101
        const val NOTIFICATION_STARTED = 0x0401
        const val PROTOCOL_ENCODE_FIRMWARE_DATA = 0x0514
        const val PROTOCOL_ENCODE_CONNECTION_SETTINGS = 0x0518
        const val PROTOCOL_ENCODE_WIFI_GRANT = 0x051a
        const val PROTOCOL_DECODE_CONNECTION_SETTINGS = 0x0509
        const val PROTOCOL_DECODE_DEVICE_LOGS = 0x050a

        const val FIELD_TIMEOUT_MS = 1
        const val FIELD_ALLOW_DUPLICATES = 2
        const val FIELD_PAYLOAD = 33
        const val FIELD_SEQUENCE = 38
        const val FIELD_LOG_MESSAGE = 46
        const val FIELD_VALUE = 30
        const val FIELD_GRANT = 58
        const val FIELD_ENABLED_WIFI = 101
        const val FIELD_ENABLED_CELLULAR = 102
        const val FIELD_CONNECTION_TYPE = 103
        const val FIELD_CELLULAR_IDLE_TIMEOUT = 104
        const val FIELD_WIFI_IDLE_TIMEOUT = 105
        const val FIELD_STREAMING_ENABLED = 106
        const val FIELD_STREAMING_FLUSH_INTERVAL = 107
        const val FIELD_HEARTBEAT_WIFI = 108
        const val FIELD_HEARTBEAT_CELLULAR = 109
        const val FIELD_DEVICE_MODEL = 111
        const val FIELD_CAPACITY = 112

        const val CAPABILITY_BLE = 1uL
        const val CAPABILITY_TIMER = 2uL
        const val ERROR_UNEXPECTED_EVENT = 9
    }
}
