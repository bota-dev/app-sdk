package dev.bota.sdk.reactnative

import android.content.Context
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.io.FileOutputStream
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

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
    val fileSizeBytes: Long? = null,
)

internal data class BotaRecordingUploadProgress(
    val taskId: String,
    val completedBytes: Long,
    val totalBytes: Long,
)

internal class BotaDeviceSDKAndroidRecordingUploads(
    private val queueFile: File,
    private val httpClient: OkHttpClient = OkHttpClient(),
    private val defaultRecordingDirectory: File = File(queueFile.parentFile, "recordings"),
    private val syncDirectory: (File) -> Unit = { directory ->
        FileChannel.open(directory.toPath(), StandardOpenOption.READ).use { it.force(true) }
    },
) {
    constructor(
        context: Context,
        httpClient: OkHttpClient = OkHttpClient(),
    ) : this(File(context.filesDir, "bota-sdk/compat-upload-queue.json"), httpClient,
        File(context.noBackupFilesDir, "bota-app-sdk/recordings"))

    @Volatile private var recordingDirectory = defaultRecordingDirectory

    fun configure(storageDirectory: File?) {
        recordingDirectory = storageDirectory?.let { File(it, "recordings") } ?: defaultRecordingDirectory
    }

    private class Operation {
        private var cancelled = false
        private var call: Call? = null

        @Synchronized fun execute(next: Call) {
            check(!cancelled) { "recording upload cancelled" }
            call = next
        }

        @Synchronized fun cancel() { cancelled = true; call?.cancel() }
        @Synchronized fun checkActive() { check(!cancelled) { "recording upload cancelled" } }
    }

    private val operations = ConcurrentHashMap<String, Operation>()
    private val cancelledAttempts = mutableSetOf<String>()
    private val journalMutex = Mutex()
    private var journalWriteUncertain = false

    suspend fun upload(
        upload: BotaRecordingUploadRequest,
        onProgress: (BotaRecordingUploadProgress) -> Unit,
    ): Unit = withContext(Dispatchers.IO) {
        val file = File(upload.localPath)
        requireOwnedFile(upload.localPath)
        require(file.isFile) { "recording file does not exist: ${upload.localPath}" }
        val total = file.length()
        require(upload.fileSizeBytes == null || upload.fileSizeBytes == total) { "stored recording length changed" }
        currentCoroutineContext().ensureActive()
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
        val operation = Operation()
        synchronized(operations) {
            check(upload.taskId !in cancelledAttempts) { "recording upload cancelled" }
            check(operations.putIfAbsent(upload.taskId, operation) == null) {
                "recording upload is already active: ${upload.taskId}"
            }
        }
        try {
            operation.execute(call)
            call.execute().use { response ->
                check(response.isSuccessful) {
                    "recording upload failed with HTTP ${response.code}"
                }
            }
            currentCoroutineContext().ensureActive()
            operation.checkActive()
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
                operation.execute(completionCall)
                completionCall.execute().use { response ->
                    check(response.isSuccessful) {
                        "recording completion failed with HTTP ${response.code}"
                    }
                }
            }
            currentCoroutineContext().ensureActive()
            operation.checkActive()
            onProgress(BotaRecordingUploadProgress(upload.taskId, total, total))
        } finally {
            operations.remove(upload.taskId, operation)
        }
    }

    suspend fun cancel(taskId: String) = withContext(Dispatchers.IO) {
        synchronized(operations) {
            cancelledAttempts.add(taskId)
            operations[taskId]?.cancel()
        }
    }

    suspend fun cancelAll() = withContext(Dispatchers.IO) {
        synchronized(operations) {
            cancelledAttempts.addAll(operations.keys)
            operations.values.forEach(Operation::cancel)
        }
    }

    suspend fun loadQueue(): String = withContext(Dispatchers.IO) {
        journalMutex.withLock {
            if (!queueFile.isFile) return@withLock "[]"
            queueFile.readText()
        }
    }

    suspend fun saveQueue(serializedTasks: String): Unit = withContext(Dispatchers.IO) {
        journalMutex.withLock { writeQueue(metadata(serializedTasks).toString()) }
    }

    suspend fun release(taskId: String, localPath: String): Unit = withContext(Dispatchers.IO) {
        journalMutex.withLock {
            check(!journalWriteUncertain) { "recording release requires durable journal completion" }
            val tasks = metadata(queueFile.readText())
            check((0 until tasks.length()).any { index ->
                val task = tasks.getJSONObject(index)
                task.optString("id") == taskId && task.optString("localPath") == localPath &&
                    task.optString("status") == "completed"
            }) { "recording release requires exact durable completion" }
            removeCompletedFile(localPath)
        }
    }

    private fun removeCompletedFile(path: String) {
        requireOwnedFile(path)
        val file = File(path)
        require(!file.exists() || (file.isFile && !Files.isSymbolicLink(file.toPath()))) { "recording release requires a regular file" }
        check(file.delete() || !file.exists()) { "completed recording cleanup deferred" }
        // A missing file may be an earlier unlink whose directory sync failed.
        syncDirectory(requireNotNull(file.parentFile))
    }

    private fun requireOwnedFile(path: String) {
        val file = File(path)
        require(file.isAbsolute && file.extension == "recording" &&
            runCatching { java.util.UUID.fromString(file.nameWithoutExtension) }.isSuccess &&
            file.canonicalFile.parentFile == recordingDirectory.canonicalFile &&
            !Files.isSymbolicLink(file.toPath()) && (!file.exists() || file.isFile)
        ) { "recording file is not owned by the native recording store" }
    }

    private fun writeQueue(serializedTasks: String) {
        journalWriteUncertain = true
        queueFile.parentFile?.mkdirs()
        queueFile.parentFile?.parentFile?.let(syncDirectory)
        val temporary = File(queueFile.parentFile, "${queueFile.name}.tmp")
        FileOutputStream(temporary).use { stream ->
            stream.write(serializedTasks.toByteArray(Charsets.UTF_8))
            stream.fd.sync()
        }
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
        queueFile.parentFile?.let(syncDirectory)
        journalWriteUncertain = false
    }

    private fun metadata(serialized: String): JSONArray {
        val tasks = JSONArray(serialized)
        val fields = setOf("id", "recordingId", "deviceId", "recordingUuid", "localPath", "status", "retryCount", "createdAt", "updatedAt", "recoveryScope", "fileSizeBytes", "nextAttemptAt", "contentType", "contentSha256", "relayUpload")
        val ids = mutableSetOf<String>()
        return JSONArray().apply {
            for (index in 0 until tasks.length()) {
                val task = tasks.getJSONObject(index)
                require(task.get("id") is String && task.getString("id").isNotEmpty() && ids.add(task.getString("id"))) { "invalid upload recovery journal" }
                for (key in listOf("recordingId", "deviceId", "localPath", "createdAt", "updatedAt")) require(task.get(key) is String) { "invalid upload recovery journal" }
                require(task.getString("recordingId").isNotEmpty() && task.getString("deviceId").isNotEmpty()) { "invalid upload recovery journal" }
                require(validInteger(task.get("retryCount")) && task.getString("status") in setOf("pending", "uploading", "completed", "failed")) { "invalid upload recovery journal" }
                for (key in listOf("recordingUuid", "recoveryScope", "contentType", "contentSha256")) if (task.has(key)) require(task.get(key) is String) { "invalid upload recovery journal" }
                for (key in listOf("fileSizeBytes", "nextAttemptAt")) if (task.has(key)) require(validInteger(task.get(key))) { "invalid upload recovery journal" }
                if (task.has("relayUpload")) require(task.get("relayUpload") is Boolean) { "invalid upload recovery journal" }
                for (key in listOf("createdAt", "updatedAt")) require(runCatching { java.time.Instant.parse(task.getString(key)) }.isSuccess) { "invalid upload recovery journal" }
                put(JSONObject().apply {
                    for (key in fields) if (task.has(key)) {
                        val value = task.get(key)
                        require(value is String || value is Number || value is Boolean) { "invalid upload recovery journal" }
                        put(key, value)
                    }
                    put("relayUpload", if (task.has("relayUpload")) task.getBoolean("relayUpload") else task.optJSONObject("relay") != null)
                })
            }
        }
    }

    private fun validInteger(value: Any): Boolean {
        if (value !is Number) return false
        val number = value.toDouble()
        return number.isFinite() && number >= 0 && number <= 9_007_199_254_740_991.0 && number % 1.0 == 0.0
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
        fileSizeBytes = if (hasKey("fileSizeBytes") && !isNull("fileSizeBytes")) getDouble("fileSizeBytes").toLong() else null,
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
