package dev.bota.sdk.internal.byo

import dev.bota.sdk.internal.jni.NativeCoreBridge
import dev.bota.sdk.internal.jni.NativePacket
import org.json.JSONObject

/** Rust owns canonical packaging and transfer evidence semantics. */
internal fun byoCustomer(command: Long, value: JSONObject): ByteArray {
    val core = NativeCoreBridge()
    try {
        val reply = core.encode(NativePacket(kind=0x0530, fieldIds=intArrayOf(97,30),
            fieldTypes=intArrayOf(1,5), unsignedValues=longArrayOf(command,0), signedValues=longArrayOf(0,0),
            dataValues=arrayOf(null,value.toString().toByteArray())))
        return reply.dataValues[reply.fieldIds.indexOf(30)] as ByteArray
    } finally { core.close() }
}
internal fun byoTransferAck(proof: JSONObject, segment: JSONObject, customer: Boolean) {
    byoCustomer(2,JSONObject().put("proof",proof).put("segment",segment).put("customer",customer))
}
