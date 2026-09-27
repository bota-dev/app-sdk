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
import org.junit.Assert.assertTrue
import org.junit.Test

class BotaDeviceSDKAndroidRecordingUploadsTest {
    @Test
    fun plaintextUploadRetainsNativeFileUntilDurableHostCompletion() = runTest {
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

        assertTrue(fixture.recordingFile.exists())
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

        uploads.saveQueue(fixture.journal("pending"))
        uploads.saveQueue(fixture.journal("failed"))

        val tasks = org.json.JSONArray(uploads.loadQueue())
        assertEquals(1, tasks.length())
        assertEquals("failed", tasks.getJSONObject(0).getString("status"))
    }

    @Test
    fun releaseRequiresExactCompletedJournalAndIsIdempotent() = runTest {
        val fixture = UploadFixture()
        val uploads = BotaDeviceSDKAndroidRecordingUploads(fixture.queueFile)
        uploads.saveQueue(fixture.journal("uploading"))
        assertTrue(runCatching { uploads.release("task-1", fixture.recordingFile.path) }.isFailure)
        assertTrue(fixture.recordingFile.exists())
        uploads.saveQueue(fixture.journal("completed"))
        assertTrue(runCatching { uploads.release("other-task", fixture.recordingFile.path) }.isFailure)
        uploads.release("task-1", fixture.recordingFile.path)
        uploads.release("task-1", fixture.recordingFile.path)
        assertFalse(fixture.recordingFile.exists())
    }

    @Test
    fun loadIsReadOnlyUntilValidatedSaveAndRelease() = runTest {
        val fixture = UploadFixture()
        fixture.queueFile.writeText(fixture.journal("completed"))
        val uploads = BotaDeviceSDKAndroidRecordingUploads(fixture.queueFile)
        val loaded = uploads.loadQueue()
        assertEquals(fixture.journal("completed"), loaded)
        assertTrue(fixture.recordingFile.exists())
        uploads.saveQueue(loaded)
        uploads.release("task-1", fixture.recordingFile.path)
        assertFalse(fixture.recordingFile.exists())
        assertFalse(fixture.queueFile.readText().contains("secret"))
    }

    @Test
    fun corruptJournalIsNotOverwritten() = runTest {
        val fixture = UploadFixture()
        fixture.queueFile.writeText("{broken")
        val uploads = BotaDeviceSDKAndroidRecordingUploads(fixture.queueFile)
        assertEquals("{broken", uploads.loadQueue())
        assertEquals("{broken", fixture.queueFile.readText())
    }

    @Test
    fun parseableInvalidJournalNeverMutatesOrDeletesFiles() = runTest {
        for ((old, invalid) in listOf(
            "\"retryCount\":0" to "\"retryCount\":-1",
            "\"createdAt\":\"2026-09-24T00:00:00Z\"" to "\"createdAt\":\"invalid\"",
            "\"status\":\"completed\"" to "\"status\":\"completed\",\"fileSizeBytes\":\"4\"",
            "\"status\":\"completed\"" to "\"status\":\"completed\",\"recoveryScope\":123",
        )) {
            val fixture = UploadFixture()
            val contents = fixture.journal("completed").replace(old, invalid)
            fixture.queueFile.writeText(contents)
            val uploads = BotaDeviceSDKAndroidRecordingUploads(fixture.queueFile)
            assertEquals(contents, uploads.loadQueue())
            assertTrue(runCatching { uploads.saveQueue(contents) }.isFailure)
            assertEquals(contents, fixture.queueFile.readText())
            assertTrue(fixture.recordingFile.exists())
        }
    }

    @Test
    fun directorySyncFailurePreventsRelease() = runTest {
        val fixture = UploadFixture()
        val uploads = BotaDeviceSDKAndroidRecordingUploads(fixture.queueFile, syncDirectory = { directory ->
            if (directory == fixture.queueFile.parentFile) error("directory sync failed")
        })
        assertTrue(runCatching { uploads.saveQueue(fixture.journal("completed")) }.isFailure)
        assertTrue(runCatching { uploads.release("task-1", fixture.recordingFile.path) }.isFailure)
        assertTrue(fixture.recordingFile.exists())
    }

    @Test
    fun cleanupDirectorySyncFailureRetainsJournalAndRetriesMissingFile() = runTest {
        val fixture = UploadFixture()
        val failure = java.io.IOException("cleanup directory sync failed")
        val uploads = BotaDeviceSDKAndroidRecordingUploads(fixture.queueFile, syncDirectory = { directory ->
            if (directory == fixture.recordingFile.parentFile) throw failure
        })
        uploads.saveQueue(fixture.journal("completed"))
        val journal = fixture.queueFile.readText()

        repeat(2) {
            val result = runCatching { uploads.release("task-1", fixture.recordingFile.path) }
            assertTrue(result.exceptionOrNull() is java.io.IOException)
            assertEquals(failure.message, result.exceptionOrNull()?.message)
            assertFalse(fixture.recordingFile.exists())
            assertEquals(journal, fixture.queueFile.readText())
        }

        val restarted = BotaDeviceSDKAndroidRecordingUploads(fixture.queueFile)
        restarted.release("task-1", fixture.recordingFile.path)
        assertFalse(fixture.recordingFile.exists())
        assertEquals(journal, fixture.queueFile.readText())
    }

    @Test
    fun cancelledAttemptCannotStartLate() = runTest {
        val fixture = UploadFixture()
        val requests = Collections.synchronizedList(mutableListOf<CapturedRequest>())
        val uploads = BotaDeviceSDKAndroidRecordingUploads(fixture.queueFile, stubbedClient(requests))
        uploads.cancel("cancelled-attempt")
        assertTrue(runCatching { uploads.upload(fixture.request("cancelled-attempt")) {} }.isFailure)
        assertTrue(requests.isEmpty())
        assertTrue(fixture.recordingFile.exists())
    }

    @Test
    fun releaseNeverDeletesADirectory() = runTest {
        val fixture = UploadFixture()
        val child = File(fixture.recordingFile.parentFile, "must-retain").apply { mkdir() }
        val uploads = BotaDeviceSDKAndroidRecordingUploads(fixture.queueFile)
        uploads.saveQueue(fixture.journal("completed").replace(fixture.recordingFile.path, child.path))
        assertTrue(runCatching { uploads.release("task-1", child.path) }.isFailure)
        assertTrue(child.isDirectory)
    }

    @Test
    fun completedJournalCannotReleaseForeignFile() = runTest {
        val fixture = UploadFixture()
        val foreign = File(fixture.queueFile.parentFile, "${java.util.UUID.randomUUID()}.recording").apply { writeText("keep") }
        val uploads = BotaDeviceSDKAndroidRecordingUploads(fixture.queueFile)
        uploads.saveQueue(fixture.journal("completed").replace(fixture.recordingFile.path, foreign.path))
        assertTrue(runCatching { uploads.release("task-1", foreign.path) }.isFailure)
        assertTrue(foreign.exists())
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
    val recordingFile = File(File(directory, "recordings").apply { mkdir() }, "${java.util.UUID.randomUUID()}.recording").apply {
        writeBytes(byteArrayOf(1, 2, 3, 4))
    }
    val queueFile = File(directory, "queue.json")

    fun journal(status: String): String = """
        [{"id":"task-1","recordingId":"rec-1","deviceId":"device-1","localPath":"${recordingFile.path}","status":"$status","retryCount":0,"createdAt":"2026-09-24T00:00:00Z","updatedAt":"2026-09-24T00:00:00Z","uploadUrl":"https://secret","uploadToken":"secret","completeUrl":"https://secret","errorMessage":"secret","relay":{"url":"https://secret","bearerToken":"secret"}}]
    """.trimIndent()

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
