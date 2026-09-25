package dev.bota.sdk.internal.host

import dev.bota.sdk.EncryptedUploadV2ContextExchange
import dev.bota.sdk.internal.core.EncryptedUploadV2ContextSnapshot
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class EncryptedUploadV2ContextHostTest {
    @Test
    fun boundedAttemptUsesIndependentNonceAndRequiresFinalAcceptance() = runTest {
        val calls = mutableListOf<String>()
        val snapshots = ArrayDeque(listOf(
            EncryptedUploadV2ContextSnapshot(7u, 0u, 0u, byteArrayOf()),
            EncryptedUploadV2ContextSnapshot(7u, 1u, 0u, ByteArray(16) { 9 }),
            EncryptedUploadV2ContextSnapshot(7u, 2u, 0u, ByteArray(116) { 8 }),
            EncryptedUploadV2ContextSnapshot(7u, 3u, 0u, byteArrayOf()),
        ))
        val host = EncryptedUploadV2ContextHost(
            begin = { calls += "begin:$it" }, read = { snapshots.removeFirst() },
            validateDocument = { kind, _ -> calls += "validate:$kind" },
            sendDocument = { kind, _ -> calls += "send:$kind" },
        )
        host.exchange(7u) { nonce ->
            assertTrue(nonce.contentEquals(ByteArray(16) { 9 }))
            calls += "provider"
            EncryptedUploadV2ContextExchange(ByteArray(196)) { proof ->
                assertTrue(proof.contentEquals(ByteArray(116) { 8 }))
                calls += "proof"
                ByteArray(264)
            }
        }
        assertTrue(snapshots.isEmpty())
        assertEquals(listOf("begin:7", "provider", "validate:3", "send:3", "proof", "validate:4", "send:4"), calls)
    }

    @Test
    fun deadlineIncludesProviderLatencyAndDoesNotSendLateChallenge() = runTest {
        var sent = 0
        val host = EncryptedUploadV2ContextHost(
            begin = {}, read = { EncryptedUploadV2ContextSnapshot(7u, 1u, 0u, ByteArray(16) { 1 }) },
            validateDocument = { _, _ -> }, sendDocument = { _, _ -> sent++ },
        )
        val start = testScheduler.currentTime
        val error = runCatching { host.exchange(7u) { awaitCancellation() } }.exceptionOrNull()
        assertEquals(15u, (error as EncryptedUploadV2HostException).errorCode)
        assertEquals(30_000L, testScheduler.currentTime - start)
        assertEquals(0, sent)
    }

    @Test
    fun failedOrAdvancedSnapshotNeverCallsProvider() = runTest {
        for (snapshot in listOf(
            EncryptedUploadV2ContextSnapshot(7u, 4u, 9u, byteArrayOf()),
            EncryptedUploadV2ContextSnapshot(7u, 2u, 0u, ByteArray(116)),
        )) {
            val host = EncryptedUploadV2ContextHost(
                begin = {}, read = { snapshot }, validateDocument = { _, _ -> }, sendDocument = { _, _ -> },
            )
            var called = false
            val error = runCatching {
                host.exchange(7u) { called = true; error("must not call") }
            }.exceptionOrNull()
            assertTrue(error is EncryptedUploadV2HostException)
            assertTrue(!called)
        }
    }
}
