package dev.bota.sdk.internal.host

import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink

internal class EncryptedUploadV2StagingUploader(private val client: OkHttpClient) : AutoCloseable {
    private val calls = ConcurrentHashMap.newKeySet<Call>()

    suspend fun upload(template: Request, file: Path) = withContext(Dispatchers.IO) {
        require(template.url.isHttps && template.method == "PUT" && (template.body?.contentLength() ?: 0L) == 0L) {
            "staging request must be an HTTPS PUT with an empty template body"
        }
        val request = template.newBuilder().put(FileRequestBody(file, template.body?.contentType())).build()
        val call = client.newCall(request)
        calls += call
        try {
            call.execute().use { response ->
                if (!response.isSuccessful) {
                    throw EncryptedUploadV2HostException(
                        12u, response.code in 500..599, response.code.toUShort(),
                        "ciphertext staging failed with HTTP ${response.code}",
                    )
                }
            }
        } finally {
            calls -= call
        }
    }

    fun cancelAll() = calls.forEach(Call::cancel)

    override fun close() = cancelAll()

    private class FileRequestBody(private val file: Path, private val mediaType: MediaType?) : RequestBody() {
        override fun contentType(): MediaType? = mediaType
        override fun contentLength(): Long = Files.size(file)

        override fun writeTo(sink: BufferedSink) {
            Files.newInputStream(file).use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    sink.write(buffer, 0, count)
                }
            }
        }
    }
}
