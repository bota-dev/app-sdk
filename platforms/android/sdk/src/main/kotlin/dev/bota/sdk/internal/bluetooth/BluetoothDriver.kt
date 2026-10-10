package dev.bota.sdk.internal.bluetooth

import dev.bota.sdk.internal.host.NativeHostException
import java.util.UUID
import kotlinx.coroutines.flow.Flow

internal open class BluetoothTransportException(
    platformCode: Int,
    message: String,
) : NativeHostException(platformCode, message)

internal class BluetoothCharacteristicNotFoundException : BluetoothTransportException(
    404, "GATT characteristic was not discovered",
)

internal data class ConfirmedBluetoothDisconnect(val peripheralId: String, val generation: Long)

internal interface BluetoothDriver : AutoCloseable {
    suspend fun connectedAdvertisements(): List<BluetoothAdvertisement>
    fun scan(allowDuplicates: Boolean): Flow<BluetoothAdvertisement>
    suspend fun stopScan()
    suspend fun connect(peripheralId: String)
    suspend fun discoverServices(peripheralId: String)
    suspend fun read(peripheralId: String, serviceUuid: UUID, characteristicUuid: UUID): ByteArray
    suspend fun write(
        peripheralId: String,
        serviceUuid: UUID,
        characteristicUuid: UUID,
        value: ByteArray,
        withResponse: Boolean,
    )
    suspend fun subscribe(peripheralId: String, serviceUuid: UUID, characteristicUuid: UUID): Flow<BluetoothNotification>
    suspend fun unsubscribe(peripheralId: String, serviceUuid: UUID, characteristicUuid: UUID)
    fun maximumWriteLength(peripheralId: String): Int
    suspend fun disconnect(peripheralId: String)
    fun connectionGeneration(peripheralId: String): Long = 1L
    fun confirmedDisconnects(): Flow<ConfirmedBluetoothDisconnect> = kotlinx.coroutines.flow.emptyFlow()
    override fun close()
}

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
