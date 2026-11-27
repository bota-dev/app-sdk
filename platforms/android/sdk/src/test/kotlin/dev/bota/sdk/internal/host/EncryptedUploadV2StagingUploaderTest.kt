package dev.bota.sdk.internal.host

import java.nio.file.Files
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EncryptedUploadV2StagingUploaderTest {
    @Test
    fun sendsTheExactCiphertextForPutAndPost() = runTest {
        val file = Files.createTempFile("bota-v2", ".ciphertext")
        val ciphertext = ByteArray(192 * 1024) { (it % 251).toByte() }
        Files.write(file, ciphertext)
        var uploaded = byteArrayOf()
        var observedMethod = ""
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            observedMethod = chain.request().method
            assertEquals("yes", chain.request().header("x-signed"))
            val buffer = Buffer()
            chain.request().body!!.writeTo(buffer)
            uploaded = buffer.readByteArray()
            Response.Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .body(byteArrayOf().toResponseBody())
                .build()
        }.build()
        val uploader = EncryptedUploadV2StagingUploader(client)

        for (method in listOf("PUT", "POST")) {
            uploader.upload(
                Request.Builder().url("https://example.test/upload").header("x-signed", "yes")
                    .method(method, byteArrayOf().toRequestBody()).build(),
                file,
            )
            assertEquals(method, observedMethod)
            assertTrue(uploaded.contentEquals(ciphertext))
            assertEquals(ciphertext.size.toLong(), uploaded.size.toLong())
        }
        uploader.close()
    }

    @Test
    fun rejectsTemplatesThatCouldSmuggleAnApplicationBody() = runTest {
        val file = Files.createTempFile("bota-v2", ".ciphertext")
        Files.write(file, byteArrayOf(1))
        val uploader = EncryptedUploadV2StagingUploader(OkHttpClient())

        assertThrows(IllegalArgumentException::class.java) {
            kotlinx.coroutines.runBlocking {
                uploader.upload(
                    Request.Builder().url("https://example.test/upload").put(byteArrayOf(9).toRequestBody()).build(),
                    file,
                )
            }
        }
    }
}
