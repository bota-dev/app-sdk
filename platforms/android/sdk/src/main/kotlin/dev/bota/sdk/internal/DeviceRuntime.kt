package dev.bota.sdk.internal

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import dev.bota.sdk.BotaOperation
import dev.bota.sdk.internal.bluetooth.BluetoothGattDriver
import dev.bota.sdk.internal.bluetooth.BluetoothGattHost
import dev.bota.sdk.internal.bluetooth.BluetoothPermissionChecker
import dev.bota.sdk.internal.bluetooth.BotaBluetoothUUIDs
import dev.bota.sdk.internal.bluetooth.FrameworkAndroidBluetoothPlatform
import dev.bota.sdk.internal.core.CoreCapabilities
import dev.bota.sdk.internal.core.CoreEngineRuntime
import dev.bota.sdk.internal.core.CoreModelMapper
import dev.bota.sdk.internal.core.CoreWorkflowRunner
import dev.bota.sdk.internal.host.AndroidKeystoreSecureStorageHost
import dev.bota.sdk.internal.host.ApplicationMaterialHost
import dev.bota.sdk.internal.host.AtomicFileJournalStore
import dev.bota.sdk.internal.host.AtomicFilePersistenceHost
import dev.bota.sdk.internal.host.FileFirmwareBlobHost
import dev.bota.sdk.internal.host.FileRecordingSinkHost
import dev.bota.sdk.internal.host.HostEffectExecutor
import dev.bota.sdk.internal.host.OkHttpNetworkHost
import dev.bota.sdk.internal.jni.NativeCoreBridge
import dev.bota.sdk.model.DeviceStatus
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import okhttp3.OkHttpClient

internal class DeviceRuntime(
    val engine: CoreWorkflowRunner,
    val capabilities: CoreCapabilities,
    val authorize: (BotaOperation) -> Unit,
    val disconnect: suspend (String) -> Unit,
    val readStatus: suspend (String) -> ByteArray,
    val statusUpdates: suspend (String) -> Flow<ByteArray>,
    val stopStatusUpdates: suspend (String) -> Unit,
    val decodeStatus: (ByteArray) -> DeviceStatus,
    private val closeResources: () -> Unit,
) : AutoCloseable {
    private val closed = AtomicBoolean(false)

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        closeResources()
    }

    internal companion object {
        fun create(
            context: Context,
            networkClient: OkHttpClient,
            storageDirectory: File?,
        ): DeviceRuntime {
            val root = storageDirectory ?: File(context.noBackupFilesDir, "bota-app-sdk")
            val closeActions = mutableListOf<() -> Unit>()
            try {
                val platform = FrameworkAndroidBluetoothPlatform(context)
                closeActions += platform::close
                val driver = BluetoothGattDriver(platform)
                closeActions[closeActions.lastIndex] = driver::close
                val permissions = BluetoothPermissionChecker(Build.VERSION.SDK_INT) { permission ->
                    context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
                }
                val bluetooth = BluetoothGattHost(driver, permissions)
                val persistence = AtomicFilePersistenceHost(AtomicFileJournalStore(File(root, "state")))
                val secureStorage = AndroidKeystoreSecureStorageHost(context, rootDirectory = File(root, "secrets"))
                val network = OkHttpNetworkHost(networkClient).also { closeActions += it::close }
                val material = ApplicationMaterialHost().also { closeActions += it::close }
                val recordingSink = FileRecordingSinkHost().also { closeActions += it::close }
                val firmwareBlob = FileFirmwareBlobHost().also { closeActions += it::close }
                val mapper = CoreModelMapper().also { closeActions += it::close }
                val host = HostEffectExecutor(
                    bluetooth = bluetooth,
                    persistence = persistence,
                    secureStorage = secureStorage,
                    network = network,
                    material = material,
                    recordingSink = recordingSink,
                    firmwareBlob = firmwareBlob,
                )
                val engine = CoreEngineRuntime(NativeCoreBridge(), host).also { closeActions += it::close }
                val allCapabilities = CoreCapabilities.Bluetooth + CoreCapabilities.Timer +
                    CoreCapabilities.Persistence + CoreCapabilities.SecureStorage +
                    CoreCapabilities.NetworkTransfer + CoreCapabilities.Progress +
                    CoreCapabilities.HostMaterial + CoreCapabilities.RecordingSink +
                    CoreCapabilities.FirmwareBlob

                fun authorize(operation: BotaOperation) {
                    when (operation) {
                        BotaOperation.Discover -> permissions.requireScan(operation)
                        else -> permissions.requireConnect(operation)
                    }
                }

                return DeviceRuntime(
                    engine = engine,
                    capabilities = allCapabilities,
                    authorize = ::authorize,
                    disconnect = driver::disconnect,
                    readStatus = { peripheralId ->
                        driver.read(peripheralId, BotaBluetoothUUIDs.ControlService, BotaBluetoothUUIDs.DeviceStatus)
                    },
                    statusUpdates = { peripheralId ->
                        driver.subscribe(
                            peripheralId,
                            BotaBluetoothUUIDs.ControlService,
                            BotaBluetoothUUIDs.DeviceStatus,
                        ).map { it.value }
                    },
                    stopStatusUpdates = { peripheralId ->
                        driver.unsubscribe(
                            peripheralId,
                            BotaBluetoothUUIDs.ControlService,
                            BotaBluetoothUUIDs.DeviceStatus,
                        )
                    },
                    decodeStatus = mapper::parseDeviceStatus,
                    closeResources = { closeAll(*closeActions.asReversed().toTypedArray()) },
                )
            } catch (failure: Throwable) {
                runCatching { closeAll(*closeActions.asReversed().toTypedArray()) }
                    .exceptionOrNull()
                    ?.let(failure::addSuppressed)
                throw failure
            }
        }
    }
}

internal fun closeAll(vararg actions: () -> Unit) {
    var firstFailure: Throwable? = null
    actions.forEach { action ->
        try {
            action()
        } catch (failure: Throwable) {
            val first = firstFailure
            if (first == null) firstFailure = failure else first.addSuppressed(failure)
        }
    }
    firstFailure?.let { throw it }
}
