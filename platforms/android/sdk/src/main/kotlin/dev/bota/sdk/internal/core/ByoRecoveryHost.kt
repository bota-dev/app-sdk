package dev.bota.sdk.internal.core

import dev.bota.sdk.internal.jni.NativeCore
import dev.bota.sdk.internal.jni.NativeCoreBridge
import dev.bota.sdk.internal.jni.NativePacket

/** Native-only owner. Store must use durable atomic replacement (including
 * directory persistence). A readback check does not replace that requirement.
 * The caller supplies fresh scope fields; opaque documents never enter here. */
internal class ByoRecoveryHost(
    private val load: () -> ByteArray?,
    private val save: (ByteArray) -> Unit,
    private val core: NativeCore = NativeCoreBridge(),
) : AutoCloseable {
    data class Decision(val phase: ULong, val retryAfterMilliseconds: ULong?, val mayCleanup: Boolean,
        val renewalRevision: ULong?, val renewalOperation: String?)
    data class RenewalRequest(val operationId: String, val expectedRevision: ULong)
    private var closed = false

    /** Metadata-only scope; request is durable before this returns for HTTP. */
    @Synchronized
    fun prepareRenewal(scope: NativePacket, operationId: String): RenewalRequest {
        val state = advance(renewalPacket(scope, 15))
        val revision = requireNotNull(state.renewalRevision)
        state.renewalOperation?.let { return RenewalRequest(it, revision) }
        val prepared = advance(renewalPacket(scope, 13, operationId, revision))
        check(prepared.renewalOperation == operationId && prepared.renewalRevision == revision)
        return RenewalRequest(operationId, revision)
    }

    /** Authenticate the reply and persist its opaque permit before calling. */
    @Synchronized
    fun acceptRenewal(scope: NativePacket, request: RenewalRequest, revision: ULong) {
        require(request.expectedRevision < UInt.MAX_VALUE.toULong() && revision == request.expectedRevision + 1uL)
        advance(renewalPacket(scope, 14, request.operationId, revision))
    }

    private fun renewalPacket(scope: NativePacket, command: Long, operation: String? = null, revision: ULong = 0uL): NativePacket {
        require(scope.kind == KIND && scope.fieldIds.none { it in setOf(97, CHECKPOINT, RENEWAL_OPERATION, RENEWAL_REVISION) })
        val hasOperation = operation != null
        return NativePacket(kind = KIND,
            fieldIds = scope.fieldIds + if (hasOperation) intArrayOf(97, RENEWAL_OPERATION, RENEWAL_REVISION) else intArrayOf(97),
            fieldTypes = scope.fieldTypes + if (hasOperation) intArrayOf(1, 4, 1) else intArrayOf(1),
            unsignedValues = scope.unsignedValues + if (hasOperation) longArrayOf(command, 0, revision.toLong()) else longArrayOf(command),
            signedValues = scope.signedValues + LongArray(if (hasOperation) 3 else 1),
            dataValues = (scope.dataValues.toList() + if (hasOperation) listOf<Any?>(null, operation!!.encodeToByteArray(), null) else listOf<Any?>(null)).toTypedArray())
    }

    @Synchronized
    fun advance(input: NativePacket): Decision {
        check(!closed) { "BYO recovery owner is closed" }
        require(input.kind == KIND && !input.fieldIds.contains(CHECKPOINT))
        val checkpoint = load()?.copyOf()
        require(checkpoint == null || checkpoint.isNotEmpty() && checkpoint.size <= 2048)
        val request = if (checkpoint == null) input else NativePacket(
            kind = KIND,
            fieldIds = input.fieldIds + CHECKPOINT,
            fieldTypes = input.fieldTypes + NativePacket.FIELD_TYPE_BYTES,
            unsignedValues = input.unsignedValues + 0L,
            signedValues = input.signedValues + 0L,
            dataValues = (input.dataValues.toList() + listOf<Any?>(checkpoint)).toTypedArray(),
        )
        val output = core.encode(request)
        require(output.kind == KIND && output.fieldIds.toSet().size == output.fieldIds.size)
        require(output.fieldIds.all { it in setOf(CHECKPOINT, PHASE, RETRY, CLEANUP, RENEWAL_REVISION, RENEWAL_OPERATION) })
        val next = output.requiredBytes(CHECKPOINT).copyOf()
        require(next.isNotEmpty() && next.size <= 2048)
        val phase = output.requiredUnsigned(PHASE)
        require(phase <= 9uL)
        val mayCleanup = output.requiredBoolean(CLEANUP)
        val retry = if (output.fieldIds.contains(RETRY)) output.requiredUnsigned(RETRY) else null
        save(next.copyOf())
        check(load()?.contentEquals(next) == true) { "BYO checkpoint readback failed" }
        val renewalRevision = if (output.fieldIds.contains(RENEWAL_REVISION)) output.requiredUnsigned(RENEWAL_REVISION) else null
        val renewalOperation = if (output.fieldIds.contains(RENEWAL_OPERATION)) output.requiredText(RENEWAL_OPERATION) else null
        return Decision(phase, retry, mayCleanup, renewalRevision, renewalOperation)
    }

    @Synchronized
    override fun close() { if (!closed) { closed = true; core.close() } }
    companion object {
        const val KIND = 0x052d
        const val CHECKPOINT = 28
        const val PHASE = 153
        const val RETRY = 220
        const val CLEANUP = 221
        const val RENEWAL_REVISION = 222
        const val RENEWAL_OPERATION = 219
    }
}
