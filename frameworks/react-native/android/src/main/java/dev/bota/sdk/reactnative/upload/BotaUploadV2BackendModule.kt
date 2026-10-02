package dev.bota.sdk.reactnative.upload

import android.system.Os
import android.system.OsConstants
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import dev.bota.sdk.reactnative.BotaDeviceSDKEncryptedUploadV2Materials
import dev.bota.sdk.reactnative.NativeBotaUploadV2BackendSpec
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject

@ReactModule(name = BotaUploadV2BackendModule.NAME)
internal class BotaUploadV2BackendModule(context: ReactApplicationContext) : NativeBotaUploadV2BackendSpec(context) {
  companion object { const val NAME = "BotaUploadV2Backend" }
  private val work = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val credentials = CredentialBroker { requestId, operationId ->
    emitOnCredentialsRequested(Arguments.createMap().apply {
      putString("requestId", requestId); putString("operationId", operationId)
    })
  }
  private val upload = NativeUpload(
    UploadJournal(File(context.noBackupFilesDir, "BotaSDKUploadV2"), object : JournalDurability {
      override fun syncDirectory(directory: File) {
        val fd = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
        try {
          demand(OsConstants.S_ISDIR(Os.fstat(fd).st_mode), "PERSISTENCE")
          Os.fsync(fd)
        } finally { Os.close(fd) }
      }
    }), BackendUploadHttp(), credentials::request, BotaDeviceSDKEncryptedUploadV2Materials::readAuthNonce,
  )
  @Volatile private var destroyed = false

  private fun invoke(promise: Promise, block: suspend () -> Any?) {
    work.launch {
      try { demand(!destroyed, "CANCELLED"); promise.resolve(block()) }
      catch (error: Exception) {
        val code = (error as? UploadFailure)?.code ?: "BOTA_UPLOAD_NATIVE"
        promise.reject(code, code, null)
      }
    }
  }
  override fun prepare(inputJSON: String, promise: Promise) = invoke(promise) {
    JSONObject(upload.prepare(inputJSON)).toString()
  }
  override fun cancel(operationId: String, promise: Promise) = invoke(promise) { upload.cancel(operationId); null }
  override fun complete(operationId: String, promise: Promise) = invoke(promise) { upload.complete(operationId); null }
  override fun resolveCredentials(requestId: String, token: String, promise: Promise) = invoke(promise) {
    credentials.resolve(requestId, token); null
  }
  override fun rejectCredentials(requestId: String, promise: Promise) = invoke(promise) {
    credentials.reject(requestId); null
  }
  override fun invalidate() {
    destroyed = true
    upload.cancelAll()
    // Dispatched identity-creating requests must drain into their original journal.
    super.invalidate()
  }
}
