package dev.bota.sdk.internal.byo

import dev.bota.sdk.internal.jni.NativeCore
import dev.bota.sdk.internal.jni.NativeCoreBridge
import dev.bota.sdk.internal.jni.NativePacket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal fun byoIdentity(uuid: String, generation: UInt): ByteArray {
    val id = UUID.fromString(uuid)
    require(id.toString() == uuid)
    return ByteBuffer.allocate(20).putLong(id.mostSignificantBits).putLong(id.leastSignificantBits)
        .order(ByteOrder.LITTLE_ENDIAN).putInt(generation.toInt()).array()
}
internal class ByoException(val reason: String, val status: Int = 0): Exception("BYO $reason")
internal class ByoBLECodec(private val core: NativeCore = NativeCoreBridge()): AutoCloseable {
    data class Frame(val opcode: Int, val operation: Int, val status: Int, val id: Long,
        val offset: Int, val total: Int, val payload: ByteArray)
    fun encode(opcode: Int, operation: Int, id: Long, offset: Int, total: Int, bytes: ByteArray, capacity: Int): ByteArray =
        core.encode(NativePacket(kind=0x052e, fieldIds=intArrayOf(127,97,24,152,39,150,112,33),
            fieldTypes=intArrayOf(1,1,1,1,1,1,1,5), unsignedValues=longArrayOf(opcode.toLong(),operation.toLong(),0,id,offset.toLong(),total.toLong(),capacity.toLong(),0),
            signedValues=LongArray(8),dataValues=arrayOf(null,null,null,null,null,null,null,bytes))).requiredBytes(30)
    fun decode(bytes: ByteArray): Frame {
        val p=core.decode(NativePacket(kind=0x052f,fieldIds=intArrayOf(30),fieldTypes=intArrayOf(5),
            unsignedValues=longArrayOf(0),signedValues=longArrayOf(0),dataValues=arrayOf(bytes)))
        require(p.kind==0x052f && p.fieldIds.toSet()==setOf(127,97,24,152,39,150,33) && p.fieldIds.size==7)
        return Frame(p.requiredUnsigned(127).toInt(),p.requiredUnsigned(97).toInt(),p.requiredUnsigned(24).toInt(),
            p.requiredUnsigned(152).toLong(),p.requiredUnsigned(39).toInt(),p.requiredUnsigned(150).toInt(),p.requiredBytes(33))
    }
    override fun close()=core.close()
}
internal interface ByoDeviceLink { suspend fun call(operation: Int, document: ByteArray=byteArrayOf()): ByteArray }
internal class ByoBLEHost(
    capacity: Int, private val write: suspend (ByteArray)->Unit,
    private val subscribe: suspend ()->Flow<ByteArray>, private val unsubscribe: suspend ()->Unit,
    private val validate: suspend ()->Unit, private val codec: ByoBLECodec=ByoBLECodec(),
): ByoDeviceLink {
    private val capacity=minOf(512,capacity)
    private val mutex=Mutex()
    private val inbox=Channel<ByteArray>(8)
    private var pump: Job?=null
    suspend fun start(scope: CoroutineScope) {
        check(pump==null && capacity>12)
        val flow=subscribe()
        pump=scope.launch(start=CoroutineStart.UNDISPATCHED) {
            try { flow.collect { if(inbox.trySend(it.copyOf()).isFailure) throw ByoException("notification_overflow") } }
            catch(e: Throwable) { inbox.close(e) }
            finally { inbox.close() }
        }
    }
    suspend fun close() = withContext(NonCancellable) {
        try { unsubscribe() } finally { pump?.cancelAndJoin();pump=null;inbox.cancel();codec.close() }
    }
    override suspend fun call(operation: Int, document: ByteArray): ByteArray=mutex.withLock {
        require(document.size<=8192 && pump!=null)
        val id=sequence.incrementAndGet();require(id in 1..0xffffffffL)
        var offset=0; var reply: ByoBLECodec.Frame
        do {
            val end=minOf(document.size,offset+capacity-12)
            reply=exchange(codec.encode(112,operation,id,offset,document.size,document.copyOfRange(offset,end),capacity),
                operation,id,if(end<document.size) end else 0)
            if(end<document.size) require(reply.status==1 && reply.offset==end && reply.total==document.size && reply.payload.isEmpty())
            else successful(reply)
            offset=end
        } while(offset<document.size)
        require(reply.offset==0 && reply.total<=8192 && reply.payload.size<=reply.total)
        val total=reply.total;val output=ByteArray(total);reply.payload.copyInto(output);offset=reply.payload.size
        while(offset<total) {
            reply=exchange(codec.encode(114,operation,id,offset,0,byteArrayOf(),capacity),operation,id,offset)
            successful(reply)
            require(reply.offset==offset && reply.total==total && reply.payload.isNotEmpty() && offset+reply.payload.size<=total)
            reply.payload.copyInto(output,offset);offset+=reply.payload.size
        }
        output
    }
    private fun successful(frame: ByoBLECodec.Frame) {
        if(frame.status==3) throw ByoException("context_expired")
        if(frame.status!=0) throw ByoException("device_rejected")
    }
    private suspend fun exchange(bytes: ByteArray, operation: Int, id: Long, offset: Int): ByoBLECodec.Frame {
        repeat(3) { attempt ->
            currentCoroutineContext().ensureActive();validate();write(bytes)
            try {
                return withTimeout(10_000) {
                    repeat(8) {
                        val frame=codec.decode(inbox.receive())
                        require(frame.opcode==113)
                        if(frame.id>=id) {
                            require(frame.id==id && frame.operation==operation)
                            if(frame.status>=2 || frame.offset==offset) {validate();return@withTimeout frame}
                        }
                    }
                    throw ByoException("protocol_violation")
                }
            } catch(e: TimeoutCancellationException) { currentCoroutineContext().ensureActive();if(attempt==2) throw ByoException("timeout") }
        }
        throw ByoException("timeout")
    }
    companion object { private val sequence=AtomicLong() }
}
