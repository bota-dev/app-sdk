package dev.bota.sdk.reactnative

import android.content.Context
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody

internal data class BotaRecordingUploadRequest(
    val taskId: String,
    val recordingId: String,
    val localPath: String,
    val uploadUrl: String,
    val uploadToken: String?,
    val completeUrl: String?,
    val contentType: String?,
    val contentSha256: String?,
    val relayUrl: String?,
    val relayBearerToken: String?,
)

internal data class BotaRecordingUploadProgress(
    val taskId: String,
    val completedBytes: Long,
    val totalBytes: Long,
)

internal class BotaDeviceSDKAndroidRecordingUploads(
    private val queueFile: File,
    private val httpClient: OkHttpClient = OkHttpClient(),
) {
    constructor(
        context: Context,
        httpClient: OkHttpClient = OkHttpClient(),
    ) : this(File(context.filesDir, "bota-sdk/compat-upload-queue.json"), httpClient)

    private val calls = ConcurrentHashMap<String, Call>()

    suspend fun upload(
        upload: BotaRecordingUploadRequest,
        onProgress: (BotaRecordingUploadProgress) -> Unit,
    ): Unit = withContext(Dispatchers.IO) {
        val file = File(upload.localPath)
        require(file.isFile) { "recording file does not exist: ${upload.localPath}" }
        val total = file.length()
        onProgress(BotaRecordingUploadProgress(upload.taskId, 0, total))
        val relay = upload.relayUrl != null
        val request = Request.Builder()
            .url(upload.relayUrl ?: upload.uploadUrl)
            .apply {
                if (relay) {
                    post(file.asRequestBody("application/octet-stream".toMediaTypeOrNull()))
                    upload.relayBearerToken?.let { header("Authorization", "Bearer $it") }
                } else {
                    put(file.asRequestBody((upload.contentType ?: "audio/opus").toMediaTypeOrNull()))
                }
            }
            .build()
        val call = httpClient.newCall(request)
        check(calls.putIfAbsent(upload.taskId, call) == null) {
            "recording upload is already active: ${upload.taskId}"
        }
        try {
            call.execute().use { response ->
                check(response.isSuccessful) {
                    "recording upload failed with HTTP ${response.code}"
                }
            }
            if (!relay && upload.completeUrl != null && upload.uploadToken != null) {
                val checksum = upload.contentSha256?.let {
                    ",\"content_sha256\":\"${it.jsonEscaped()}\""
                }.orEmpty()
                val body = "{\"recording_id\":\"${upload.recordingId.jsonEscaped()}\"$checksum}"
                val complete = Request.Builder()
                    .url(upload.completeUrl)
                    .header("Authorization", "Bearer ${upload.uploadToken}")
                    .post(body.toRequestBody("application/json".toMediaTypeOrNull()))
                    .build()
                val completionCall = httpClient.newCall(complete)
                calls[upload.taskId] = completionCall
                completionCall.execute().use { response ->
                    check(response.isSuccessful) {
                        "recording completion failed with HTTP ${response.code}"
                    }
                }
            }
            onProgress(BotaRecordingUploadProgress(upload.taskId, total, total))
            check(file.delete() || !file.exists()) {
                "uploaded recording file could not be removed"
            }
        } finally {
            calls.remove(upload.taskId)
        }
    }

    suspend fun cancel(taskId: String) = withContext(Dispatchers.IO) {
        calls.remove(taskId)?.cancel()
    }

    suspend fun cancelAll() = withContext(Dispatchers.IO) {
        calls.values.forEach(Call::cancel)
        calls.clear()
    }

    suspend fun loadQueue(): String = withContext(Dispatchers.IO) {
        if (queueFile.isFile) queueFile.readText() else "[]"
    }

    suspend fun saveQueue(serializedTasks: String): Unit = withContext(Dispatchers.IO) {
        queueFile.parentFile?.mkdirs()
        val temporary = File(queueFile.parentFile, "${queueFile.name}.tmp")
        temporary.writeText(serializedTasks)
        try {
            Files.move(
                temporary.toPath(),
                queueFile.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(
                temporary.toPath(),
                queueFile.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
            )
        }
    }
}

internal fun ReadableMap.toRecordingUploadRequest(): BotaRecordingUploadRequest =
    BotaRecordingUploadRequest(
        taskId = requiredString("taskId"),
        recordingId = requiredString("recordingId"),
        localPath = requiredString("localPath"),
        uploadUrl = requiredString("uploadUrl"),
        uploadToken = optionalString("uploadToken"),
        completeUrl = optionalString("completeUrl"),
        contentType = optionalString("contentType"),
        contentSha256 = optionalString("contentSha256"),
        relayUrl = optionalString("relayUrl"),
        relayBearerToken = optionalString("relayBearerToken"),
    )

internal fun BotaRecordingUploadProgress.toWritableMap(): WritableMap =
    Arguments.createMap().apply {
        putString("taskId", taskId)
        putDouble("completedBytes", completedBytes.toDouble())
        putDouble("totalBytes", totalBytes.toDouble())
    }

private fun ReadableMap.requiredString(key: String): String =
    getString(key) ?: error("$key is required")

private fun ReadableMap.optionalString(key: String): String? =
    if (hasKey(key) && !isNull(key)) getString(key) else null

private fun String.jsonEscaped(): String = buildString(length) {
    for (character in this@jsonEscaped) {
        when (character) {
            '\\' -> append("\\\\")
            '"' -> append("\\\"")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> append(character)
        }
    }
}
