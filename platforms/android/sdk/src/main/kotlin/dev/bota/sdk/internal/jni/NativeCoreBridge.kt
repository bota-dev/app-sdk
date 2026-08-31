package dev.bota.sdk.internal.jni

internal interface NativeCore : AutoCloseable {
    fun start(command: NativePacket, capabilityBits: ULong)
    fun poll(): NativePacket?
    fun dispatch(event: NativePacket)
    fun cancel(cancellationHigh: ULong, cancellationLow: ULong)
    fun decode(packet: NativePacket): NativePacket
    fun encode(packet: NativePacket): NativePacket
    override fun close()
}

internal class NativeCoreBridge : NativeCore {
    private var engine: Long = NativeBindings.createEngine().also {
        check(it != 0L) { "native engine allocation failed" }
    }

    @Synchronized
    override fun start(command: NativePacket, capabilityBits: ULong) {
        NativeBindings.start(requireEngine(), command, capabilityBits.toLong())
    }

    @Synchronized
    override fun poll(): NativePacket? = NativeBindings.poll(requireEngine())

    @Synchronized
    override fun dispatch(event: NativePacket) {
        NativeBindings.dispatch(requireEngine(), event)
    }

    @Synchronized
    override fun cancel(cancellationHigh: ULong, cancellationLow: ULong) {
        NativeBindings.cancel(requireEngine(), cancellationHigh.toLong(), cancellationLow.toLong())
    }

    @Synchronized
    override fun decode(packet: NativePacket): NativePacket =
        NativeBindings.decode(requireEngine(), packet)

    @Synchronized
    override fun encode(packet: NativePacket): NativePacket =
        NativeBindings.encode(requireEngine(), packet)

    @Synchronized
    override fun close() {
        val current = engine
        if (current == 0L) return
        engine = 0L
        NativeBindings.closeEngine(current)
    }

    private fun requireEngine(): Long = engine.takeIf { it != 0L }
        ?: throw IllegalStateException("native core is closed")

    internal companion object {
        fun abiVersion(): Int = NativeBindings.abiVersion()

        fun resetTestCounters() {
            NativeBindings.resetTestCounters()
        }

        fun testCounters(): LongArray = NativeBindings.testCounters()
    }
}

private object NativeBindings {
    init {
        System.loadLibrary("bota_device_sdk_ffi")
        System.loadLibrary("bota_android_jni")
    }

    external fun abiVersion(): Int
    external fun createEngine(): Long
    external fun closeEngine(engine: Long)
    external fun start(engine: Long, packet: NativePacket, capabilityBits: Long)
    external fun poll(engine: Long): NativePacket?
    external fun dispatch(engine: Long, packet: NativePacket)
    external fun cancel(engine: Long, cancellationHigh: Long, cancellationLow: Long)
    external fun decode(engine: Long, packet: NativePacket): NativePacket
    external fun encode(engine: Long, packet: NativePacket): NativePacket
    external fun resetTestCounters()
    external fun testCounters(): LongArray
}
