package dev.bota.sdk.internal.host

import dev.bota.sdk.EncryptedUploadV2Material
import dev.bota.sdk.EncryptedUploadV2SecurityPolicy
import dev.bota.sdk.EncryptedUploadV2TransferEvidence
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.fail
import org.junit.Test

internal class EncryptedUploadV2MaterialRegistryTest {
    @Test
    fun alreadyStagedMaterialSkipsRequestAndRejectsLateDecision() = runTest {
        val registry = EncryptedUploadV2MaterialRegistry()
        registry.register("material-1", material(shouldUpload = { false }))
        val prepared = registry.preparedMaterial("material-1")
        assertFalse(registry.shouldUploadCiphertext("material-1", prepared.lease, evidence(ByteArray(580))))
        registry.terminate("material-1", EncryptedUploadV2TerminalOutcome.Completed)
        assertFailsSuspend<EncryptedUploadV2MaterialRegistryException> {
            registry.shouldUploadCiphertext("material-1", prepared.lease, evidence(ByteArray(580)))
        }
    }
    @Test
    fun applicationMaterialStaysNativeAndCompletionIsReceiptGated() = runTest {
        val calls = mutableListOf<String>()
        val authorization = ByteArray(408) { 0x11 }
        val manifest = ByteArray(580) { 0x22 }
        val receipt = ByteArray(336) { 0x33 }
        val evidence = evidence(manifest)
        val registry = EncryptedUploadV2MaterialRegistry()
        registry.register(
            "material-1",
            material(
                authorization = authorization,
                receipt = receipt,
                calls = calls,
            ),
        )

        val prepared = registry.preparedMaterial("material-1")
        val request = registry.stagingRequest("material-1", prepared.lease, evidence)
        registry.submitManifest("material-1", prepared.lease, manifest, evidence)
        val accepted = registry.finalizeAndReceiveReceipt("material-1", prepared.lease, evidence)

        assertArrayEquals(authorization, prepared.authorization)
        assertArrayEquals(sha256(authorization), prepared.authorizationSha256)
        assertEquals("https://staging.example/upload", request.url.toString())
        assertEquals("PUT", request.method)
        assertEquals(0L, request.body?.contentLength())
        assertArrayEquals(receipt, accepted.receipt)
        assertArrayEquals(sha256(receipt), accepted.receiptSha256)
        assertEquals(listOf("staging", "manifest", "finalize", "receipt"), calls)
    }

    @Test
    fun terminalCleanupRemovesLeaseBeforeCancellationFailure() = runTest {
        val registry = EncryptedUploadV2MaterialRegistry()
        registry.register(
            "material-1",
            material(cancel = { error("cancel failed") }),
        )

        assertFailsSuspend<IllegalStateException> {
            registry.terminate("material-1", EncryptedUploadV2TerminalOutcome.Failed)
        }
        assertFalse(registry.contains("material-1"))
        registry.terminate("material-1", EncryptedUploadV2TerminalOutcome.Failed)
    }

    @Test
    fun documentsRequestsAndReplacementLeasesAreValidatedExactly() = runTest {
        val registry = EncryptedUploadV2MaterialRegistry()
        assertFailsSuspend<EncryptedUploadV2MaterialRegistryException> {
            registry.register("bad material", material())
        }
        assertFailsSuspend<EncryptedUploadV2MaterialRegistryException> {
            registry.register("short-auth", material(authorization = ByteArray(407)))
        }
        registry.register("material-1", material())
        val prepared = registry.preparedMaterial("material-1")
        registry.terminate("material-1", EncryptedUploadV2TerminalOutcome.Completed)
        registry.register("material-1", material())

        assertFailsSuspend<EncryptedUploadV2MaterialRegistryException> {
            registry.stagingRequest("material-1", prepared.lease, evidence(ByteArray(580)))
        }
        val replacement = registry.preparedMaterial("material-1")
        assertFailsSuspend<EncryptedUploadV2MaterialRegistryException> {
            registry.submitManifest("material-1", replacement.lease, ByteArray(579), evidence(ByteArray(580)))
        }
    }

    private fun material(
        authorization: ByteArray = ByteArray(408) { 1 },
        receipt: ByteArray = ByteArray(336) { 2 },
        calls: MutableList<String> = mutableListOf(),
        cancel: suspend () -> Unit = { calls += "cancel" },
        shouldUpload: suspend (EncryptedUploadV2TransferEvidence) -> Boolean = { true },
    ) = EncryptedUploadV2Material(
        materialId = "material-1",
        recordingId = "recording-1",
        uploadSessionId = UUID.randomUUID(),
        ownerRevision = 1u,
        policy = EncryptedUploadV2SecurityPolicy.V2Required,
        authorization = authorization,
        stagingRequest = {
            calls += "staging"
            Request.Builder().url("https://staging.example/upload")
                .put(ByteArray(0).toRequestBody("application/octet-stream".toMediaTypeOrNull()))
                .build()
        },
        submitManifest = { _, _ -> calls += "manifest" },
        finalize = { calls += "finalize" },
        completionReceipt = {
            calls += "receipt"
            receipt
        },
        cancel = cancel,
        shouldUploadCiphertext = shouldUpload,
    )

    private fun evidence(manifest: ByteArray) = EncryptedUploadV2TransferEvidence(
        ciphertextLength = 128u,
        ciphertextSha256 = ByteArray(32) { 3 },
        manifestLength = 580u,
        manifestSha256 = sha256(manifest),
        blockCount = 1u,
    )

    private fun sha256(value: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(value)
}

private suspend inline fun <reified T : Throwable> assertFailsSuspend(
    noinline block: suspend () -> Unit,
): T = try {
    block()
    fail("expected ${T::class.java.simpleName}")
    error("unreachable")
} catch (error: Throwable) {
    if (error !is T) throw error
    error
}
