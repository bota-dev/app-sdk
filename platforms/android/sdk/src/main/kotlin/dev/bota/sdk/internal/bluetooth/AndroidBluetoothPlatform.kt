package dev.bota.sdk.internal.bluetooth

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelUuid
import java.util.IdentityHashMap
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.suspendCancellableCoroutine

internal data class BluetoothAdvertisement(
    val peripheralId: String,
    val name: String?,
    val rssi: Int,
    val advertisedAddress: String?,
)

internal data class GattResult<T>(val generation: Long, val status: Int, val value: T)

internal data class GattCharacteristic(val serviceUuid: UUID, val characteristicUuid: UUID)

internal data class GattDiscovery(
    val serviceUuids: Set<UUID>,
    val characteristics: Set<GattCharacteristic>,
)

internal enum class GattWriteApi { Api33, Legacy }

internal class BluetoothNotification(generation: Long, value: ByteArray) {
    val generation: Long = generation
    val value: ByteArray = value.copyOf()
}

internal interface AndroidBluetoothPlatform : AutoCloseable {
    val apiLevel: Int
    suspend fun connectedAdvertisements(): List<BluetoothAdvertisement>
    fun scan(allowDuplicates: Boolean): Flow<BluetoothAdvertisement>
    suspend fun stopScan()
    suspend fun connect(peripheralId: String, generation: Long): GattResult<Unit>
    suspend fun requestMtu(peripheralId: String, generation: Long, mtu: Int): GattResult<Int>
    suspend fun discoverServices(peripheralId: String, generation: Long): GattResult<GattDiscovery>
    suspend fun read(
        peripheralId: String,
        generation: Long,
        serviceUuid: UUID,
        characteristicUuid: UUID,
    ): GattResult<ByteArray>
    suspend fun write(
        peripheralId: String,
        generation: Long,
        serviceUuid: UUID,
        characteristicUuid: UUID,
        value: ByteArray,
        withResponse: Boolean,
        api: GattWriteApi,
    ): GattResult<Unit>
    suspend fun setNotification(
        peripheralId: String,
        generation: Long,
        serviceUuid: UUID,
        characteristicUuid: UUID,
        enabled: Boolean,
    ): GattResult<Unit>
    suspend fun writeCccd(
        peripheralId: String,
        generation: Long,
        serviceUuid: UUID,
        characteristicUuid: UUID,
        enabled: Boolean,
        api: GattWriteApi,
    ): GattResult<Unit>
    suspend fun notifications(
        peripheralId: String,
        generation: Long,
        serviceUuid: UUID,
        characteristicUuid: UUID,
    ): Flow<BluetoothNotification>
    suspend fun disconnect(peripheralId: String, generation: Long): GattResult<Unit>
    override fun close()
}

@SuppressLint("MissingPermission")
internal class FrameworkAndroidBluetoothPlatform(context: Context) : AndroidBluetoothPlatform {
    private data class OperationKey(val peripheralId: String, val generation: Long)
    private data class CharacteristicKey(
        val peripheralId: String,
        val generation: Long,
        val serviceUuid: UUID,
        val characteristicUuid: UUID,
    )

    private val applicationContext = context.applicationContext
    private val thread = HandlerThread("bota-bluetooth").apply { start() }
    private val handler = Handler(thread.looper)
    private val manager = applicationContext.getSystemService(BluetoothManager::class.java)
    private val devices = mutableMapOf<String, BluetoothDevice>()
    private val gatts = mutableMapOf<String, BluetoothGatt>()
    private val gattGenerations = IdentityHashMap<BluetoothGatt, Long>()
    private val connects = mutableMapOf<OperationKey, CancellableContinuation<GattResult<Unit>>>()
    private val mtus = mutableMapOf<OperationKey, CancellableContinuation<GattResult<Int>>>()
    private val discoveries = mutableMapOf<OperationKey, CancellableContinuation<GattResult<GattDiscovery>>>()
    private val reads = mutableMapOf<CharacteristicKey, CancellableContinuation<GattResult<ByteArray>>>()
    private val writes = mutableMapOf<CharacteristicKey, CancellableContinuation<GattResult<Unit>>>()
    private val descriptors = mutableMapOf<CharacteristicKey, CancellableContinuation<GattResult<Unit>>>()
    private val disconnects = mutableMapOf<OperationKey, CancellableContinuation<GattResult<Unit>>>()
    private val notificationStreams = mutableMapOf<CharacteristicKey, MutableSharedFlow<Result<ByteArray>>>()
    private var scanCallback: ScanCallback? = null
    private var closeScan: (() -> Unit)? = null
    private var gattCallback: BluetoothGattCallback? = null

    override val apiLevel: Int = Build.VERSION.SDK_INT

    override suspend fun connectedAdvertisements(): List<BluetoothAdvertisement> = onHandler {
        manager.getConnectedDevices(BluetoothProfile.GATT).map { device ->
            devices[device.address] = device
            BluetoothAdvertisement(device.address, device.name, 0, null)
        }
    }

    override fun scan(allowDuplicates: Boolean): Flow<BluetoothAdvertisement> = callbackFlow {
        handler.post {
            try {
                stopScanOnHandler()
                val callback = object : ScanCallback() {
                    override fun onScanResult(callbackType: Int, result: ScanResult) {
                        handler.post {
                            devices[result.device.address] = result.device
                            trySend(result.advertisement())
                        }
                    }

                    override fun onBatchScanResults(results: MutableList<ScanResult>) {
                        results.forEach { onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, it) }
                    }

                    override fun onScanFailed(errorCode: Int) {
                        handler.post { close(BluetoothTransportException(errorCode, "BLE scan failed")) }
                    }
                }
                scanCallback = callback
                closeScan = { close() }
                val filters = BotaBluetoothUUIDs.BotaServices.map { service ->
                    ScanFilter.Builder().setServiceUuid(ParcelUuid(service)).build()
                } + ScanFilter.Builder().setManufacturerData(BotaBluetoothUUIDs.ManufacturerId, byteArrayOf()).build()
                val settings = ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                    .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
                    .build()
                manager.adapter.bluetoothLeScanner.startScan(filters, settings, callback)
            } catch (error: Throwable) {
                close(error)
            }
        }
        awaitClose { handler.post { stopScanOnHandler() } }
    }

    override suspend fun stopScan() = onHandler { stopScanOnHandler() }

    override suspend fun connect(peripheralId: String, generation: Long): GattResult<Unit> =
        suspendCancellableCoroutine { continuation ->
            handler.post {
                try {
                    val device = devices[peripheralId] ?: manager.adapter.getRemoteDevice(peripheralId).also {
                        devices[peripheralId] = it
                    }
                    val key = OperationKey(peripheralId, generation)
                    connects.remove(key)?.cancel()
                    connects[key] = continuation
                    val gatt = device.connectGatt(
                        applicationContext,
                        false,
                        callbackOnHandler(),
                        BluetoothDevice.TRANSPORT_LE,
                        BluetoothDevice.PHY_LE_1M_MASK,
                        handler,
                    )
                    gatts.put(peripheralId, gatt)?.let { oldGatt ->
                        gattGenerations.remove(oldGatt)
                        oldGatt.disconnect()
                        oldGatt.close()
                    }
                    gattGenerations[gatt] = generation
                    continuation.invokeOnCancellation {
                        handler.post {
                            connects.remove(key)
                            gatt.disconnect()
                        }
                    }
                } catch (error: Throwable) {
                    connects.remove(OperationKey(peripheralId, generation))
                    continuation.resumeWithException(error)
                }
            }
        }

    override suspend fun requestMtu(peripheralId: String, generation: Long, mtu: Int): GattResult<Int> =
        pending(peripheralId, generation, mtus) { gatt -> gatt.requestMtu(mtu) }

    override suspend fun discoverServices(peripheralId: String, generation: Long): GattResult<GattDiscovery> =
        pending(peripheralId, generation, discoveries, BluetoothGatt::discoverServices)

    override suspend fun read(
        peripheralId: String,
        generation: Long,
        serviceUuid: UUID,
        characteristicUuid: UUID,
    ): GattResult<ByteArray> {
        val key = CharacteristicKey(peripheralId, generation, serviceUuid, characteristicUuid)
        return pending(key, reads) { gatt, characteristic -> gatt.readCharacteristic(characteristic) }
    }

    override suspend fun write(
        peripheralId: String,
        generation: Long,
        serviceUuid: UUID,
        characteristicUuid: UUID,
        value: ByteArray,
        withResponse: Boolean,
        api: GattWriteApi,
    ): GattResult<Unit> {
        val key = CharacteristicKey(peripheralId, generation, serviceUuid, characteristicUuid)
        return if (!withResponse) {
            onHandler {
                val (gatt, characteristic) = characteristic(key)
                val status = writeCharacteristic(gatt, characteristic, value, false, api)
                GattResult(generation, status, Unit)
            }
        } else {
            pending(key, writes) { gatt, characteristic ->
                writeCharacteristic(gatt, characteristic, value, true, api) == BluetoothGatt.GATT_SUCCESS
            }
        }
    }

    override suspend fun setNotification(
        peripheralId: String,
        generation: Long,
        serviceUuid: UUID,
        characteristicUuid: UUID,
        enabled: Boolean,
    ): GattResult<Unit> = onHandler {
        val key = CharacteristicKey(peripheralId, generation, serviceUuid, characteristicUuid)
        val (gatt, characteristic) = characteristic(key)
        if (enabled) notificationStreams.getOrPut(key) { MutableSharedFlow(extraBufferCapacity = 64) }
        val status = if (gatt.setCharacteristicNotification(characteristic, enabled)) 0 else ImmediateFailure
        GattResult(generation, status, Unit)
    }

    override suspend fun writeCccd(
        peripheralId: String,
        generation: Long,
        serviceUuid: UUID,
        characteristicUuid: UUID,
        enabled: Boolean,
        api: GattWriteApi,
    ): GattResult<Unit> {
        val key = CharacteristicKey(peripheralId, generation, serviceUuid, characteristicUuid)
        return suspendCancellableCoroutine { continuation ->
            handler.post {
                try {
                    val (gatt, characteristic) = characteristic(key)
                    val descriptor = characteristic.getDescriptor(BotaBluetoothUUIDs.Cccd)
                        ?: throw BluetoothTransportException(404, "CCCD was not discovered")
                    descriptors.remove(key)?.cancel()
                    descriptors[key] = continuation
                    continuation.invokeOnCancellation { handler.post { descriptors.remove(key) } }
                    val value = if (enabled) BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        else BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
                    val started = if (api == GattWriteApi.Api33 && Build.VERSION.SDK_INT >= 33) {
                        gatt.writeDescriptor(descriptor, value) == BluetoothStatusCodes.SUCCESS
                    } else {
                        @Suppress("DEPRECATION")
                        descriptor.value = value
                        @Suppress("DEPRECATION")
                        gatt.writeDescriptor(descriptor)
                    }
                    if (!started) descriptors.remove(key)?.resume(GattResult(generation, ImmediateFailure, Unit))
                } catch (error: Throwable) {
                    descriptors.remove(key)
                    continuation.resumeWithException(error)
                }
            }
        }
    }

    override suspend fun notifications(
        peripheralId: String,
        generation: Long,
        serviceUuid: UUID,
        characteristicUuid: UUID,
    ): Flow<BluetoothNotification> {
        val key = CharacteristicKey(peripheralId, generation, serviceUuid, characteristicUuid)
        val stream = onHandler {
            notificationStreams.getOrPut(key) { MutableSharedFlow(extraBufferCapacity = 64) }
        }
        return stream.map { result -> BluetoothNotification(generation, result.getOrThrow()) }
    }

    override suspend fun disconnect(peripheralId: String, generation: Long): GattResult<Unit> =
        suspendCancellableCoroutine { continuation ->
            handler.post {
                val key = OperationKey(peripheralId, generation)
                val gatt = gatts[peripheralId]
                if (gatt == null) {
                    continuation.resume(GattResult(generation, 0, Unit))
                    return@post
                }
                disconnects.remove(key)?.cancel()
                disconnects[key] = continuation
                continuation.invokeOnCancellation { handler.post { disconnects.remove(key) } }
                gatt.disconnect()
            }
        }

    override fun close() {
        handler.post {
            stopScanOnHandler()
            gatts.values.forEach {
                it.disconnect()
                it.close()
            }
            gatts.clear()
            notificationStreams.values.forEach { it.tryEmit(Result.failure(BluetoothTransportException(499, "closed"))) }
            notificationStreams.clear()
            thread.quitSafely()
        }
    }

    private fun callbackOnHandler(): BluetoothGattCallback = gattCallback ?: object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            handler.post {
                val generation = gattGenerations[gatt] ?: return@post
                val key = OperationKey(gatt.device.address, generation)
                if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    connects.remove(key)?.resume(GattResult(generation, status, Unit))
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    connects.remove(key)?.resume(GattResult(generation, status.takeIf { it != 0 } ?: ImmediateFailure, Unit))
                    disconnects.remove(key)?.resume(GattResult(generation, status, Unit))
                    failNotifications(gatt.device.address, generation, status)
                    if (gatts[gatt.device.address] === gatt) gatts.remove(gatt.device.address)
                    gattGenerations.remove(gatt)
                    gatt.close()
                }
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            val generation = gattGenerations[gatt] ?: return
            mtus.remove(OperationKey(gatt.device.address, generation))?.resume(GattResult(generation, status, mtu))
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val generation = gattGenerations[gatt] ?: return
            val services = gatt.services.map { it.uuid }.toSet()
            val characteristics = gatt.services.flatMap { service ->
                service.characteristics.map { GattCharacteristic(service.uuid, it.uuid) }
            }.toSet()
            discoveries.remove(OperationKey(gatt.device.address, generation))
                ?.resume(GattResult(generation, status, GattDiscovery(services, characteristics)))
        }

        @Deprecated("Legacy callback for Android 12 and below")
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) = completeRead(gatt, characteristic, characteristic.value ?: byteArrayOf(), status)

        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int,
        ) = completeRead(gatt, characteristic, value, status)

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            characteristicKey(gatt, characteristic)?.let { key ->
                writes.remove(key)?.resume(GattResult(key.generation, status, Unit))
            }
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            characteristicKey(gatt, descriptor.characteristic)?.let { key ->
                descriptors.remove(key)?.resume(GattResult(key.generation, status, Unit))
            }
        }

        @Deprecated("Legacy callback for Android 12 and below")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) =
            completeNotification(gatt, characteristic, characteristic.value ?: byteArrayOf())

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) = completeNotification(gatt, characteristic, value)
    }.also { gattCallback = it }

    private fun completeRead(
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        value: ByteArray,
        status: Int,
    ) {
        characteristicKey(gatt, characteristic)?.let { key ->
            reads.remove(key)?.resume(GattResult(key.generation, status, value.copyOf()))
        }
    }

    private fun completeNotification(
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        value: ByteArray,
    ) {
        characteristicKey(gatt, characteristic)?.let { key ->
            notificationStreams[key]?.tryEmit(Result.success(value.copyOf()))
        }
    }

    private fun characteristicKey(
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
    ): CharacteristicKey? {
        val generation = gattGenerations[gatt] ?: return null
        return CharacteristicKey(gatt.device.address, generation, characteristic.service.uuid, characteristic.uuid)
    }

    private fun failNotifications(peripheralId: String, generation: Long, status: Int) {
        val error = BluetoothTransportException(status, "device disconnected")
        notificationStreams.filterKeys { it.peripheralId == peripheralId && it.generation == generation }
            .values.forEach { it.tryEmit(Result.failure(error)) }
    }

    private suspend fun <T> pending(
        peripheralId: String,
        generation: Long,
        pending: MutableMap<OperationKey, CancellableContinuation<GattResult<T>>>,
        start: (BluetoothGatt) -> Boolean,
    ): GattResult<T> = suspendCancellableCoroutine { continuation ->
        handler.post {
            try {
                val key = OperationKey(peripheralId, generation)
                val gatt = requireGatt(peripheralId, generation)
                pending.remove(key)?.cancel()
                pending[key] = continuation
                continuation.invokeOnCancellation { handler.post { pending.remove(key) } }
                if (!start(gatt)) {
                    pending.remove(key)
                    continuation.resumeWithException(
                        BluetoothTransportException(ImmediateFailure, "GATT operation did not start"),
                    )
                }
            } catch (error: Throwable) {
                pending.remove(OperationKey(peripheralId, generation))
                continuation.resumeWithException(error)
            }
        }
    }

    private suspend fun <T> pending(
        key: CharacteristicKey,
        pending: MutableMap<CharacteristicKey, CancellableContinuation<GattResult<T>>>,
        start: (BluetoothGatt, BluetoothGattCharacteristic) -> Boolean,
    ): GattResult<T> = suspendCancellableCoroutine { continuation ->
        handler.post {
            try {
                val (gatt, characteristic) = characteristic(key)
                pending.remove(key)?.cancel()
                pending[key] = continuation
                continuation.invokeOnCancellation { handler.post { pending.remove(key) } }
                if (!start(gatt, characteristic)) {
                    pending.remove(key)
                    continuation.resumeWithException(
                        BluetoothTransportException(ImmediateFailure, "GATT operation did not start"),
                    )
                }
            } catch (error: Throwable) {
                pending.remove(key)
                continuation.resumeWithException(error)
            }
        }
    }

    private fun requireGatt(peripheralId: String, generation: Long): BluetoothGatt {
        val gatt = gatts[peripheralId] ?: throw BluetoothTransportException(404, "device is not connected")
        if (gattGenerations[gatt] != generation) throw BluetoothTransportException(409, "stale GATT generation")
        return gatt
    }

    private fun characteristic(key: CharacteristicKey): Pair<BluetoothGatt, BluetoothGattCharacteristic> {
        val gatt = requireGatt(key.peripheralId, key.generation)
        val characteristic = gatt.getService(key.serviceUuid)?.getCharacteristic(key.characteristicUuid)
            ?: throw BluetoothTransportException(404, "GATT characteristic was not discovered")
        return gatt to characteristic
    }

    private fun writeCharacteristic(
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        value: ByteArray,
        withResponse: Boolean,
        api: GattWriteApi,
    ): Int {
        val writeType = if (withResponse) BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            else BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        return if (api == GattWriteApi.Api33 && Build.VERSION.SDK_INT >= 33) {
            gatt.writeCharacteristic(characteristic, value, writeType)
        } else {
            @Suppress("DEPRECATION")
            characteristic.writeType = writeType
            @Suppress("DEPRECATION")
            characteristic.value = value
            @Suppress("DEPRECATION")
            if (gatt.writeCharacteristic(characteristic)) BluetoothGatt.GATT_SUCCESS else ImmediateFailure
        }
    }

    private fun stopScanOnHandler() {
        scanCallback?.let { callback -> manager.adapter.bluetoothLeScanner?.stopScan(callback) }
        scanCallback = null
        closeScan?.invoke()
        closeScan = null
    }

    private fun ScanResult.advertisement(): BluetoothAdvertisement {
        val address = scanRecord?.getManufacturerSpecificData(BotaBluetoothUUIDs.ManufacturerId)
            ?.takeIf { it.size >= 6 }
            ?.take(6)
            ?.joinToString("") { "%02x".format(it) }
        return BluetoothAdvertisement(device.address, scanRecord?.deviceName ?: device.name, rssi, address)
    }

    private suspend fun <T> onHandler(block: () -> T): T = suspendCancellableCoroutine { continuation ->
        handler.post {
            runCatching(block).fold(continuation::resume, continuation::resumeWithException)
        }
    }

    private companion object {
        const val ImmediateFailure: Int = -1
    }
}
