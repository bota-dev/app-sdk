package dev.bota.sdk.reactnative

import java.io.File
import java.nio.file.Files
import java.util.Collections
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class BotaDeviceSDKAndroidRecordingUploadsTest {
    @Test
    fun plaintextUploadUsesPutCompletesAndDeletesNativeFile() = runTest {
        val fixture = UploadFixture()
        val requests = Collections.synchronizedList(mutableListOf<CapturedRequest>())
        val uploads = BotaDeviceSDKAndroidRecordingUploads(
            fixture.queueFile,
            stubbedClient(requests),
        )
        val progress = mutableListOf<BotaRecordingUploadProgress>()

        uploads.upload(
            fixture.request(
                taskId = "task-1",
                completeUrl = "https://api.example/complete",
                uploadToken = "up-token",
            ),
            progress::add,
        )

        assertFalse(fixture.recordingFile.exists())
        assertEquals(
            listOf(
                CapturedRequest("PUT", "https://s3.example/recording", null),
                CapturedRequest(
                    "POST",
                    "https://api.example/complete",
                    "Bearer up-token",
                ),
            ),
            requests,
        )
        assertEquals(listOf(0L, 4L), progress.map { it.completedBytes })
        assertEquals(listOf(4L, 4L), progress.map { it.totalBytes })
    }

    @Test
    fun encryptedUploadUsesRelayAndSkipsCompletion() = runTest {
        val fixture = UploadFixture()
        val requests = Collections.synchronizedList(mutableListOf<CapturedRequest>())
        val uploads = BotaDeviceSDKAndroidRecordingUploads(
            fixture.queueFile,
            stubbedClient(requests),
        )

        uploads.upload(
            fixture.request(
                taskId = "task-2",
                completeUrl = "https://api.example/unused",
                uploadToken = "up-token",
                relayUrl = "https://api.example/upload-relay",
                relayBearerToken = "device-token",
            ),
        ) {}

        assertEquals(
            listOf(
                CapturedRequest(
                    "POST",
                    "https://api.example/upload-relay",
                    "Bearer device-token",
                ),
            ),
            requests,
        )
    }

    @Test
    fun queueSaveAtomicallyReplacesExistingMetadata() = runTest {
        val fixture = UploadFixture()
        val uploads = BotaDeviceSDKAndroidRecordingUploads(
            fixture.queueFile,
            stubbedClient(mutableListOf()),
        )

        uploads.saveQueue("[{\"id\":\"first\"}]")
        uploads.saveQueue("[{\"id\":\"second\"}]")

        assertEquals("[{\"id\":\"second\"}]", uploads.loadQueue())
    }

    private fun stubbedClient(requests: MutableList<CapturedRequest>): OkHttpClient =
        OkHttpClient.Builder()
            .addInterceptor { chain ->
                val request = chain.request()
                requests += CapturedRequest(
                    request.method,
                    request.url.toString(),
                    request.header("Authorization"),
                )
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body("".toResponseBody())
                    .build()
            }
            .build()
}

private data class CapturedRequest(
    val method: String,
    val url: String,
    val authorization: String?,
)

private class UploadFixture {
    private val directory = Files.createTempDirectory("bota-recording-upload").toFile()
    val recordingFile = File(directory, "recording.bin").apply {
        writeBytes(byteArrayOf(1, 2, 3, 4))
    }
    val queueFile = File(directory, "queue.json")

    fun request(
        taskId: String,
        completeUrl: String? = null,
        uploadToken: String? = null,
        relayUrl: String? = null,
        relayBearerToken: String? = null,
    ): BotaRecordingUploadRequest = BotaRecordingUploadRequest(
        taskId = taskId,
        recordingId = "rec-1",
        localPath = recordingFile.path,
        uploadUrl = "https://s3.example/recording",
        uploadToken = uploadToken,
        completeUrl = completeUrl,
        contentType = "audio/ogg",
        contentSha256 = "abc123",
        relayUrl = relayUrl,
        relayBearerToken = relayBearerToken,
    )
}
