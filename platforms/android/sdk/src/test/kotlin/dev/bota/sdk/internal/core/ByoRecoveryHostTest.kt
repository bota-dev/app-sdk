package dev.bota.sdk.internal.core

import dev.bota.sdk.internal.jni.NativeCore
import dev.bota.sdk.internal.jni.NativePacket
import org.junit.Assert.*
import org.junit.Test

class ByoRecoveryHostTest {
    @Test fun persistenceAndReadbackPrecedeCleanupDecision() {
        var disk: ByteArray? = null
        val order = mutableListOf<String>()
        val host = ByoRecoveryHost(load = { order += "load"; disk }, save = { order += "save"; disk = it }, core = Core())
        assertTrue(host.advance(NativePacket(ByoRecoveryHost.KIND)).mayCleanup)
        assertEquals(listOf("load", "save", "load"), order)
        assertArrayEquals(byteArrayOf(1, 2, 3), disk)
    }
    @Test fun failedFlushOrReadbackNeverReturnsAnAction() {
        for (throws in listOf(false, true)) {
            val host = ByoRecoveryHost(load = { null }, save = { if (throws) error("flush failed") }, core = Core())
            assertThrows(IllegalStateException::class.java) { host.advance(NativePacket(ByoRecoveryHost.KIND)) }
        }
    }
    @Test fun lostRenewalResponseReusesTheDurableRequest() {
        val operation = "00112233-4455-4677-8899-aabbccddeeff"
        var disk: ByteArray? = byteArrayOf(7)
        val core = Core(NativePacket(kind = ByoRecoveryHost.KIND,
            fieldIds = intArrayOf(28, 153, 221, 222, 219), fieldTypes = intArrayOf(5, 1, 3, 1, 4),
            unsignedValues = longArrayOf(0, 5, 0, 2, 0), signedValues = LongArray(5),
            dataValues = arrayOf(byteArrayOf(7), null, null, null, operation.encodeToByteArray())))
        val host = ByoRecoveryHost(load = { disk }, save = { disk = it }, core = core)
        val request = host.prepareRenewal(NativePacket(ByoRecoveryHost.KIND), "10112233-4455-4677-8899-aabbccddeeff")
        assertEquals(ByoRecoveryHost.RenewalRequest(operation, 2uL), request)
        assertThrows(IllegalArgumentException::class.java) {
            host.acceptRenewal(NativePacket(ByoRecoveryHost.KIND), request, 4uL)
        }
    }
    private class Core(private val reply: NativePacket = NativePacket(kind = ByoRecoveryHost.KIND,
            fieldIds = intArrayOf(28, 153, 221), fieldTypes = intArrayOf(5, 1, 3),
            unsignedValues = longArrayOf(0, 8, 1), signedValues = LongArray(3),
            dataValues = arrayOf(byteArrayOf(1, 2, 3), null, null))) : NativeCore {
        override fun encode(packet: NativePacket) = reply
        override fun decode(packet: NativePacket): NativePacket = error("unexpected decode")
        override fun start(command: NativePacket, capabilityBits: ULong) = error("unexpected start")
        override fun poll(): NativePacket? = null
        override fun dispatch(event: NativePacket) = error("unexpected dispatch")
        override fun cancel(cancellationHigh: ULong, cancellationLow: ULong) = error("unexpected cancel")
        override fun close() {}
    }
}
