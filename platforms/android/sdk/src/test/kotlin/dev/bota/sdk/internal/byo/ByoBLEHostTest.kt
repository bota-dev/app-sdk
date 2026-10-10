package dev.bota.sdk.internal.byo

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow
import org.junit.Assert.*
import org.junit.Test

class ByoBLEHostTest {
    @Test fun fragmentsRequestsAndPullsBoundedResponsesThroughRealCodec()=runBlocking {
        val notifications=Channel<ByteArray>(8)
        val request=ByteArray(600){it.toByte()};val response=ByteArray(5000){(it*3).toByte()}
        val received=java.io.ByteArrayOutputStream();var closed=false
        ByoBLECodec().use {codec ->
            val host=ByoBLEHost(244,write={bytes ->
                val frame=codec.decode(bytes)
                if(frame.opcode==112) {assertEquals(received.size(),frame.offset);received.write(frame.payload)}
                val ack=frame.opcode==112 && received.size()<request.size
                val offset=if(ack) received.size() else if(frame.opcode==114) frame.offset else 0
                val payload=if(ack) byteArrayOf() else response.copyOfRange(offset,minOf(offset+232,response.size))
                val header=ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN)
                    .put(113).put(3).put(frame.operation.toByte()).put(if(ack) 1 else 0).putInt(frame.id.toInt())
                    .putShort(offset.toShort()).putShort((if(ack) request.size else response.size).toShort()).array()
                notifications.send(header+payload)
            },subscribe={notifications.receiveAsFlow()},unsubscribe={closed=true;notifications.close()},validate={})
            host.start(this)
            try {assertArrayEquals(response,host.call(3,request));assertArrayEquals(request,received.toByteArray())}
            finally {host.close()}
        }
        assertTrue(closed)
    }
    @Test fun cancellationSettlesAnOutstandingResponseWait()=runBlocking {
        val notifications=Channel<ByteArray>(8);val wrote=CompletableDeferred<Unit>();var closed=false
        val host=ByoBLEHost(244,write={wrote.complete(Unit)},subscribe={notifications.receiveAsFlow()},
            unsubscribe={closed=true;notifications.close()},validate={})
        host.start(this)
        val task=async(start=CoroutineStart.UNDISPATCHED) {host.call(1)}
        withTimeout(5000) {wrote.await();task.cancelAndJoin();host.close()}
        assertTrue(task.isCancelled && closed)
    }
}
