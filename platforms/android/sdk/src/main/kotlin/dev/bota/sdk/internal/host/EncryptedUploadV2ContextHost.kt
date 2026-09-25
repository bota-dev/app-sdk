package dev.bota.sdk.internal.host

import dev.bota.sdk.EncryptedUploadV2ContextProvider
import dev.bota.sdk.internal.core.EncryptedUploadV2ContextSnapshot
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeoutOrNull

internal class EncryptedUploadV2ContextHost(
    private val begin: suspend (UInt) -> Unit,
    private val read: suspend () -> EncryptedUploadV2ContextSnapshot,
    private val validateDocument: (UByte, ByteArray) -> Unit,
    private val sendDocument: suspend (UByte, ByteArray) -> Unit,
) {
    suspend fun exchange(attemptId: UInt, provider: EncryptedUploadV2ContextProvider) {
        require(attemptId != 0u)
        val completed = withTimeoutOrNull(30_000) {
            begin(attemptId)
            currentCoroutineContext().ensureActive()
            val nonce = waitFor(attemptId, 1u)
            currentCoroutineContext().ensureActive()
            val exchange = provider(nonce.copyOf())
            currentCoroutineContext().ensureActive()
            val challenge = exchange.challenge
            validateDocument(3u, challenge)
            sendDocument(3u, challenge)
            val proof = waitFor(attemptId, 2u)
            val result = exchange.exchangeProof(proof.copyOf()).copyOf()
            currentCoroutineContext().ensureActive()
            validateDocument(4u, result)
            sendDocument(4u, result)
            waitFor(attemptId, 3u)
            true
        }
        if (completed == null) throw EncryptedUploadV2HostException(
            15u, true, message = "encrypted upload context timed out",
        )
    }

    private suspend fun waitFor(attemptId: UInt, state: UByte): ByteArray {
        while (true) {
            currentCoroutineContext().ensureActive()
            val snapshot = read()
            currentCoroutineContext().ensureActive()
            if (snapshot.attemptId == attemptId) {
                if (snapshot.state == 4.toUByte()) throw EncryptedUploadV2HostException(
                    17u, false, snapshot.result, "device rejected encrypted upload context",
                )
                if (snapshot.state == state) return snapshot.payload
                if (snapshot.state > state) throw EncryptedUploadV2HostException(
                    9u, false, message = "unexpected encrypted upload context state",
                )
            }
            delay(150)
        }
    }
}
