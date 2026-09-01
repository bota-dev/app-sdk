package dev.bota.sdk.reactnative

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.module.annotations.ReactModule
import dev.bota.sdk.DeviceReconnectHint
import dev.bota.sdk.DeviceApiEnvironment
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

@ReactModule(name = NativeBotaDeviceSDKSpec.NAME)
internal class BotaDeviceSDKModule(
    reactContext: ReactApplicationContext,
    private val lifecycle: BotaDeviceSDKAndroidLifecycle =
        BotaDeviceSDKAndroidLifecycle(BotaDeviceSDKSharedAndroidClient(reactContext)),
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) : NativeBotaDeviceSDKSpec(reactContext) {
    private val devices = BotaDeviceSDKAndroidDevices(BotaDeviceSDKSharedAndroidDeviceClient(), scope)
    private val logs = BotaDeviceSDKAndroidLogs(BotaDeviceSDKSharedAndroidLogClient(), scope)
    private val ota = BotaDeviceSDKAndroidOTA()
    private val recordings = BotaDeviceSDKAndroidRecordings()
    private val security = BotaDeviceSDKAndroidSecurity(
        BotaDeviceSDKSharedAndroidSecurityClient(),
        scope,
    )
    private val wifi = BotaDeviceSDKAndroidWiFi(BotaDeviceSDKSharedAndroidWiFiClient(), scope)

    override fun configure(configuration: ReadableMap, promise: Promise) {
        val storageDirectory =
            if (configuration.hasKey("applicationSupportDirectory") &&
                !configuration.isNull("applicationSupportDirectory")
            ) {
                configuration.getString("applicationSupportDirectory")?.let(::File)
            } else {
                null
            }
        launch(promise) { lifecycle.configure(storageDirectory) }
    }

    override fun destroy(promise: Promise) {
        launch(promise) {
            security.cancelAll()
            wifi.cancelAll()
            logs.cancelAll()
            ota.cancelAll()
            recordings.cancelAll()
            devices.stopAll()
            lifecycle.destroy()
        }
    }

    override fun startScan(timeoutMs: Double, allowDuplicates: Boolean, promise: Promise) {
        launch(promise) {
            devices.startScan(timeoutMs.toTimeoutMilliseconds(), allowDuplicates) {
                emitOnDeviceDiscovered(it.toWritableMap())
            }
        }
    }

    override fun stopScan(promise: Promise) {
        launch(promise) { devices.stopScan() }
    }

    override fun connectSelected(device: ReadableMap, promise: Promise) {
        launchValue(promise) { devices.connect(device.toDiscoveredDevice()).toWritableMap() }
    }

    override fun reconnect(serialNumber: String, options: ReadableMap, promise: Promise) {
        launchValue(promise) {
            devices.reconnect(
                serialNumber,
                DeviceReconnectHint(
                    scanTimeoutMilliseconds = options.getDouble("scanTimeoutMs").toTimeoutMilliseconds(),
                    connectionTimeoutMilliseconds = options
                        .getDouble("connectionTimeoutMs")
                        .toTimeoutMilliseconds(),
                ),
            ).toWritableMap()
        }
    }

    override fun disconnect(promise: Promise) {
        launch(promise) { devices.disconnect() }
    }

    override fun isProvisioned(device: ReadableMap, promise: Promise) {
        launchValue(promise) { security.isProvisioned(device.toConnectedDevice()) }
    }

    override fun readPublicKey(device: ReadableMap, promise: Promise) {
        launchValue(promise) { security.readPublicKey(device.toConnectedDevice()) }
    }

    override fun readAuthNonce(device: ReadableMap, promise: Promise) {
        launchValue(promise) { security.readAuthNonce(device.toConnectedDevice()) }
    }

    override fun setApiEndpoint(device: ReadableMap, environment: String, promise: Promise) {
        launch(promise) {
            security.setApiEndpoint(environment.toDeviceApiEnvironment(), device.toConnectedDevice())
        }
    }

    override fun deliverCertificate(
        device: ReadableMap,
        certificatePem: String,
        privateKeyPem: String,
        promise: Promise,
    ) {
        launch(promise) {
            security.deliverCertificate(certificatePem, privateKeyPem, device.toConnectedDevice())
        }
    }

    override fun deliverBackendPublicKey(
        device: ReadableMap,
        publicKeyHex: String,
        promise: Promise,
    ) {
        launch(promise) {
            security.deliverBackendPublicKey(publicKeyHex.hexBytes(), device.toConnectedDevice())
        }
    }

    override fun writeGrant(device: ReadableMap, grantBlob: String, promise: Promise) {
        launch(promise) { security.writeGrant(grantBlob, device.toConnectedDevice()) }
    }

    override fun syncTime(device: ReadableMap, promise: Promise) {
        launch(promise) { security.syncTime(device.toConnectedDevice()) }
    }

    override fun requestStartRecording(
        device: ReadableMap,
        grantBlob: String,
        promise: Promise,
    ) {
        launchValue(promise) {
            security.requestStartRecording(device.toConnectedDevice(), grantBlob).toWritableMap()
        }
    }

    override fun requestStopRecording(
        device: ReadableMap,
        grantBlob: String,
        promise: Promise,
    ) {
        launchValue(promise) {
            security.requestStopRecording(device.toConnectedDevice(), grantBlob).toWritableMap()
        }
    }

    override fun readRecordingState(device: ReadableMap, promise: Promise) {
        launchValue(promise) {
            security.readRecordingState(device.toConnectedDevice()).toWritableMap()
        }
    }

    override fun startRecordingStateUpdates(device: ReadableMap, promise: Promise) {
        launch(promise) {
            security.startRecordingStateUpdates(device.toConnectedDevice()) {
                emitOnRecordingStateUpdated(it.toWritableMap())
            }
        }
    }

    override fun stopRecordingStateUpdates(promise: Promise) {
        launch(promise) { security.stopRecordingStateUpdates() }
    }

    override fun configureWiFi(
        device: ReadableMap,
        ssid: String,
        password: String,
        grantBlob: String,
        promise: Promise,
    ) {
        launchValue(promise) {
            wifi.configure(device.toConnectedDevice(), ssid, password, grantBlob).toWritableMap()
        }
    }

    override fun disconnectWiFi(device: ReadableMap, promise: Promise) {
        launchValue(promise) { wifi.disconnect(device.toConnectedDevice()).toWritableMap() }
    }

    override fun readWiFiStatus(device: ReadableMap, promise: Promise) {
        launchValue(promise) { wifi.readStatus(device.toConnectedDevice()).toWritableMap() }
    }

    override fun startWiFiStatusUpdates(device: ReadableMap, promise: Promise) {
        launch(promise) {
            wifi.startStatusUpdates(device.toConnectedDevice()) {
                emitOnWiFiStatusUpdated(it.toWritableMap())
            }
        }
    }

    override fun stopWiFiStatusUpdates(promise: Promise) {
        launch(promise) { wifi.stopStatusUpdates() }
    }

    override fun scanWiFiNetworks(device: ReadableMap, promise: Promise) {
        launchValue(promise) { wifi.scanNetworks(device.toConnectedDevice()).toWritableMap() }
    }

    override fun listRecordings(device: ReadableMap, promise: Promise) {
        launchValue(promise) {
            Arguments.createArray().apply {
                recordings.listRecordings(device.toConnectedDevice()).forEach {
                    pushMap(it.toWritableMap())
                }
            }
        }
    }

    override fun syncRecording(
        device: ReadableMap,
        recording: ReadableMap,
        promise: Promise,
    ) {
        launchValue(promise) {
            recordings.syncRecording(
                device.toConnectedDevice(),
                recording.toDeviceRecording(),
            ) {
                emitOnRecordingTransferProgress(it.toWritableMap())
            }
        }
    }

    override fun observeUploadOwnership(
        device: ReadableMap,
        request: ReadableMap,
        promise: Promise,
    ) {
        launchValue(promise) {
            recordings.observeUploadOwnership(
                device = device.toConnectedDevice(),
                recordingUuid = request.getString("recordingUuid")
                    ?: error("recording UUID is required"),
                uploadId = request.getString("uploadId") ?: error("upload ID is required"),
                destinationId = request.getString("destinationId")
                    ?: error("destination ID is required"),
            ) {
                emitOnUploadOwnershipProgress(it.toWritableMap())
            }.toWritableMap()
        }
    }

    override fun updateFirmware(
        device: ReadableMap,
        image: ReadableMap,
        promise: Promise,
    ) {
        launch(promise) {
            ota.updateFirmware(
                device = device.toConnectedDevice(),
                version = image.getString("version") ?: error("firmware version is required"),
                sizeBytes = image.getDouble("sizeUnits").toUnsignedInt(),
                crc32 = image.getDouble("crc32").toUnsignedInt(),
                url = image.getString("url") ?: error("firmware URL is required"),
            ) {
                emitOnFirmwareUpdateProgress(it.toWritableMap())
            }
        }
    }

    override fun startDeviceLogs(device: ReadableMap, promise: Promise) {
        launch(promise) {
            logs.start(device.toConnectedDevice()) {
                emitOnDeviceLog(it.toWritableMap())
            }
        }
    }

    override fun stopDeviceLogs(promise: Promise) {
        launch(promise) { logs.stop() }
    }

    override fun readStatus(promise: Promise) {
        launchValue(promise) { devices.readStatus().toWritableMap() }
    }

    override fun startStatusUpdates(promise: Promise) {
        launch(promise) {
            devices.startStatusUpdates {
                emitOnDeviceStatusUpdated(it.toWritableMap())
            }
        }
    }

    override fun stopStatusUpdates(promise: Promise) {
        launch(promise) { devices.stopStatusUpdates() }
    }

    override fun provision(device: ReadableMap, promise: Promise) {
        launch(promise) {
            security.provision(device.toConnectedDevice()) {
                emitOnProvisioningMaterialRequested(it.toWritableMap())
            }
        }
    }

    override fun deprovision(device: ReadableMap, grantBlob: String, promise: Promise) {
        launchValue(promise) {
            security.deprovision(device.toConnectedDevice(), grantBlob).toWritableMap()
        }
    }

    override fun readConnectionSettings(device: ReadableMap, promise: Promise) {
        launchValue(promise) {
            security.readConnectionSettings(device.toConnectedDevice()).toWritableMap()
        }
    }

    override fun writeConnectionSettings(
        device: ReadableMap,
        settings: ReadableMap,
        promise: Promise,
    ) {
        launch(promise) {
            security.writeConnectionSettings(
                settings.toDeviceConnectionSettings(),
                device.toConnectedDevice(),
            )
        }
    }

    override fun factoryReset(
        device: ReadableMap,
        commandId: String,
        bindingGeneration: Double,
        requiresApplicationPersistence: Boolean,
        promise: Promise,
    ) {
        launchValue(promise) {
            security.factoryReset(
                device = device.toConnectedDevice(),
                commandId = commandId,
                bindingGeneration = bindingGeneration.toUnsignedInteger(),
                onGrantRequest = { emitOnFactoryResetGrantRequested(it.toWritableMap()) },
                onPersistenceRequest = if (requiresApplicationPersistence) {
                    { emitOnFactoryResetResultPersistenceRequested(it.toWritableMap()) }
                } else {
                    null
                },
            ).toWritableMap()
        }
    }

    override fun resumePendingFactoryReset(
        device: ReadableMap,
        currentBindingGeneration: Double,
        requiresApplicationPersistence: Boolean,
        promise: Promise,
    ) {
        launchValue(promise) {
            security.resumePendingFactoryReset(
                device.toConnectedDevice(),
                currentBindingGeneration.toUnsignedInteger(),
                if (requiresApplicationPersistence) {
                    { emitOnFactoryResetResultPersistenceRequested(it.toWritableMap()) }
                } else {
                    null
                },
            )?.toWritableMap()
        }
    }

    override fun resolveProvisioningMaterial(
        requestId: String,
        material: ReadableMap,
        promise: Promise,
    ) {
        launch(promise) {
            security.resolveProvisioningMaterial(
                requestId = requestId,
                apiEndpoint = material.getString("apiEndpoint")
                    ?: error("provisioning API endpoint is required"),
                deviceToken = material.getString("deviceToken")
                    ?: error("provisioning device token is required"),
                mtu = material.getDouble("mtu").toUnsignedInteger(),
            )
        }
    }

    override fun resolveFactoryResetGrant(
        requestId: String,
        grantBlob: String,
        promise: Promise,
    ) {
        launch(promise) { security.resolveFactoryResetGrant(requestId, grantBlob) }
    }

    override fun resolveFactoryResetResultPersistence(requestId: String, promise: Promise) {
        launch(promise) { security.resolveFactoryResetResultPersistence(requestId) }
    }

    override fun rejectApplicationMaterial(requestId: String, message: String, promise: Promise) {
        launch(promise) { security.rejectApplicationMaterial(requestId, message) }
    }

    override fun getCapabilities(promise: Promise) {
        val capabilities = lifecycle.capabilities()
        promise.resolve(
            Arguments.createMap().apply {
                putBoolean("backgroundReconnect", capabilities.backgroundReconnect)
                putBoolean("backgroundScan", capabilities.backgroundScan)
                putBoolean("bluetooth", capabilities.bluetooth)
                putBoolean("nativeFileTransfer", capabilities.nativeFileTransfer)
                putString("platform", capabilities.platform)
            },
        )
    }

    override fun getState(promise: Promise) {
        promise.resolve(lifecycle.state())
    }

    override fun invalidate() {
        scope.launch {
            try {
                security.cancelAll()
                wifi.cancelAll()
                logs.cancelAll()
                ota.cancelAll()
                recordings.cancelAll()
                devices.stopAll()
                lifecycle.destroy()
            } finally {
                scope.cancel()
            }
        }
        super.invalidate()
    }

    private fun launch(promise: Promise, operation: suspend () -> Unit) {
        scope.launch {
            try {
                operation()
                promise.resolve(null)
            } catch (error: Throwable) {
                promise.reject(ERROR_CODE, error.message ?: "Bota Android SDK operation failed", error)
            }
        }
    }

    private fun launchValue(promise: Promise, operation: suspend () -> Any?) {
        scope.launch {
            try {
                promise.resolve(operation())
            } catch (error: Throwable) {
                promise.reject(ERROR_CODE, error.message ?: "Bota Android SDK operation failed", error)
            }
        }
    }

    companion object {
        const val NAME = NativeBotaDeviceSDKSpec.NAME
        private const val ERROR_CODE = "android_sdk_error"
    }
}

private fun Double.toTimeoutMilliseconds(): ULong {
    require(isFinite() && this >= 0 && this <= Long.MAX_VALUE.toDouble()) {
        "timeout must be a finite non-negative number"
    }
    return toLong().toULong()
}

private fun Double.toUnsignedInteger(): ULong {
    require(isFinite() && this >= 0 && this <= 9_007_199_254_740_991.0 && this % 1.0 == 0.0) {
        "value must be a finite non-negative integer"
    }
    return toLong().toULong()
}

private fun Double.toUnsignedInt(): UInt {
    val value = toUnsignedInteger()
    require(value <= UInt.MAX_VALUE.toULong()) {
        "value must fit an unsigned 32-bit integer"
    }
    return value.toUInt()
}

private fun String.toDeviceApiEnvironment(): DeviceApiEnvironment = when (this) {
    "development" -> DeviceApiEnvironment.Development
    "gamma" -> DeviceApiEnvironment.Gamma
    "production" -> DeviceApiEnvironment.Production
    else -> error("unsupported API environment: $this")
}

private fun String.hexBytes(): ByteArray {
    require(length % 2 == 0 && all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) {
        "public key must be lowercase or uppercase hexadecimal"
    }
    return chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
