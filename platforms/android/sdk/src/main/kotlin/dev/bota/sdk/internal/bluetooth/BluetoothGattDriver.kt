package dev.bota.sdk.internal.bluetooth

import dev.bota.sdk.internal.host.NativeHostException
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.transform
import kotlinx.coroutines.withTimeout

internal open class BluetoothTransportException(
    platformCode: Int,
    message: String,
) : NativeHostException(platformCode, message)

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
    suspend fun disconnect(peripheralId: String)
    override fun close()
}

internal class BluetoothGattDriver(
    private val platform: AndroidBluetoothPlatform,
    private val queue: GattOperationQueue = GattOperationQueue(),
    private val operationTimeoutMilliseconds: Long = 10_000,
) : BluetoothDriver {
    private val generationLock = Any()
    private val generations = mutableMapOf<String, Long>()

    override suspend fun connectedAdvertisements(): List<BluetoothAdvertisement> = platform.connectedAdvertisements()

    override fun scan(allowDuplicates: Boolean): Flow<BluetoothAdvertisement> = platform.scan(allowDuplicates)

    override suspend fun stopScan() = platform.stopScan()

    override suspend fun connect(peripheralId: String) = operation(peripheralId) {
        val generation = synchronized(generationLock) {
            (generations[peripheralId] ?: 0L).plus(1).also { generations[peripheralId] = it }
        }
        validate(peripheralId, generation, platform.connect(peripheralId, generation))
        validate(peripheralId, generation, platform.requestMtu(peripheralId, generation, PreferredMtu))
        Unit
    }

    override suspend fun discoverServices(peripheralId: String) = operation(peripheralId) {
        val generation = generation(peripheralId)
        val discovery = validate(peripheralId, generation, platform.discoverServices(peripheralId, generation))
        if (discovery.serviceUuids.none(BotaBluetoothUUIDs.BotaServices::contains)) {
            throw BluetoothTransportException(404, "no Bota GATT service was discovered")
        }
    }

    override suspend fun read(
        peripheralId: String,
        serviceUuid: UUID,
        characteristicUuid: UUID,
    ): ByteArray = operation(peripheralId) {
        val generation = generation(peripheralId)
        validate(peripheralId, generation, platform.read(peripheralId, generation, serviceUuid, characteristicUuid))
    }

    override suspend fun write(
        peripheralId: String,
        serviceUuid: UUID,
        characteristicUuid: UUID,
        value: ByteArray,
        withResponse: Boolean,
    ) = operation(peripheralId) {
        val generation = generation(peripheralId)
        validate(
            peripheralId,
            generation,
            platform.write(
                peripheralId,
                generation,
                serviceUuid,
                characteristicUuid,
                value,
                withResponse,
                writeApi,
            ),
        )
    }

    override suspend fun subscribe(
        peripheralId: String,
        serviceUuid: UUID,
        characteristicUuid: UUID,
    ): Flow<BluetoothNotification> = operation(peripheralId) {
        val generation = generation(peripheralId)
        validate(
            peripheralId,
            generation,
            platform.setNotification(peripheralId, generation, serviceUuid, characteristicUuid, true),
        )
        validate(
            peripheralId,
            generation,
            platform.writeCccd(peripheralId, generation, serviceUuid, characteristicUuid, true, writeApi),
        )
        platform.notifications(peripheralId, generation, serviceUuid, characteristicUuid).transform { notification ->
            if (notification.generation == generation) emit(notification)
        }
    }

    override suspend fun unsubscribe(peripheralId: String, serviceUuid: UUID, characteristicUuid: UUID) =
        operation(peripheralId) {
            val generation = generation(peripheralId)
            validate(
                peripheralId,
                generation,
                platform.setNotification(peripheralId, generation, serviceUuid, characteristicUuid, false),
            )
            validate(
                peripheralId,
                generation,
                platform.writeCccd(peripheralId, generation, serviceUuid, characteristicUuid, false, writeApi),
            )
        }

    override suspend fun disconnect(peripheralId: String) {
        queue.cancel(peripheralId)
        val generation = synchronized(generationLock) { generations[peripheralId] } ?: return
        try {
            withTimeout(operationTimeoutMilliseconds) {
                validate(peripheralId, generation, platform.disconnect(peripheralId, generation))
            }
        } finally {
            synchronized(generationLock) { generations.remove(peripheralId) }
        }
    }

    override fun close() {
        synchronized(generationLock) { generations.keys.toList() }.forEach(queue::cancel)
        synchronized(generationLock) { generations.clear() }
        platform.close()
    }

    private suspend fun <T> operation(peripheralId: String, block: suspend () -> T): T = try {
        withTimeout(operationTimeoutMilliseconds) { queue.run(peripheralId, block) }
    } catch (error: BluetoothTransportException) {
        throw error
    } catch (_: TimeoutCancellationException) {
        throw BluetoothTransportException(408, "GATT operation timed out for $peripheralId")
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        throw BluetoothTransportException(408, "GATT operation failed: ${error.message ?: error::class.simpleName}")
    }

    private fun generation(peripheralId: String): Long = synchronized(generationLock) {
        generations[peripheralId]
    } ?: throw BluetoothTransportException(404, "device $peripheralId is not connected")

    private fun <T> validate(peripheralId: String, generation: Long, result: GattResult<T>): T {
        if (result.generation != generation) {
            throw BluetoothTransportException(409, "stale GATT callback for $peripheralId")
        }
        if (result.status != 0) {
            throw BluetoothTransportException(result.status, "GATT status ${result.status} for $peripheralId")
        }
        return result.value
    }

    private val writeApi: GattWriteApi
        get() = if (platform.apiLevel >= 33) GattWriteApi.Api33 else GattWriteApi.Legacy

    private companion object {
        const val PreferredMtu: Int = 517
    }
}
