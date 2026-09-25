package dev.bota.sdk.internal.bluetooth

import dev.bota.sdk.EncryptedUploadV2Recording
import dev.bota.sdk.internal.core.CoreModelMapper
import dev.bota.sdk.internal.core.EncryptedUploadV2TransferControlValue
import dev.bota.sdk.internal.host.EncryptedUploadV2HostException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull

internal class EncryptedUploadV2CatalogReader(
    private val driver: BluetoothDriver,
    private val mapper: CoreModelMapper,
) {
    private var uncertainOwner: ConfirmedBluetoothDisconnect? = null

    suspend fun read(peripheralId: String, sessionId: ULong): List<EncryptedUploadV2Recording> {
        val owner = ConfirmedBluetoothDisconnect(peripheralId, driver.connectionGeneration(peripheralId))
        if (uncertainOwner == owner) throw EncryptedUploadV2HostException(
            19u, false, message = "catalog cleanup is uncertain; reconnect before retrying",
        )
        val subscriptions = mutableListOf<java.util.UUID>()
        var failure: Throwable? = null
        try {
            mapper.consumeEncryptedUploadV2Catalog(sessionId, byteArrayOf())
            return withTimeoutOrNull(30_000) {
                coroutineScope {
                    val result = CompletableDeferred<List<EncryptedUploadV2Recording>>()
                    subscriptions += BotaBluetoothUUIDs.RecordingListV2
                    val entries = driver.subscribe(peripheralId, BotaBluetoothUUIDs.StorageService, subscriptions.last())
                    val listJob = launch(start = CoroutineStart.UNDISPATCHED) {
                        try {
                            entries.collect { notification ->
                                if (!result.isCompleted) mapper.consumeEncryptedUploadV2Catalog(sessionId, notification.value)?.let { result.complete(it) }
                            }
                            if (!result.isCompleted) result.completeExceptionally(ended())
                        } catch (error: Throwable) { result.completeExceptionally(error) }
                    }
                    subscriptions += BotaBluetoothUUIDs.RecordingTransferV2
                    val errors = driver.subscribe(peripheralId, BotaBluetoothUUIDs.StorageService, subscriptions.last())
                    val errorJob = launch(start = CoroutineStart.UNDISPATCHED) {
                        try {
                            errors.collect { notification ->
                                val value = mapper.decodeEncryptedUploadV2TransferControl(notification.value)
                                if (value !is EncryptedUploadV2TransferControlValue.Error) throw EncryptedUploadV2HostException(
                                    9u, false, message = "unexpected encrypted catalog response",
                                )
                                if (value.value.transportSessionId == sessionId) {
                                    if (value.value.failedMessageType != 0x25.toUByte()) throw ended()
                                    result.completeExceptionally(EncryptedUploadV2HostException(
                                        17u, false, value.value.result, "device rejected encrypted catalog",
                                    ))
                                }
                            }
                            if (!result.isCompleted) result.completeExceptionally(ended())
                        } catch (error: Throwable) { result.completeExceptionally(error) }
                    }
                    try {
                        if (result.isCompleted) result.await()
                        driver.write(peripheralId, BotaBluetoothUUIDs.StorageService,
                            BotaBluetoothUUIDs.TransferControlV2, mapper.createEncryptedUploadV2List(sessionId), true)
                        result.await()
                    } finally {
                        listJob.cancel()
                        errorJob.cancel()
                    }
                }
            } ?: throw EncryptedUploadV2HostException(15u, true, message = "encrypted catalog timed out")
        } catch (error: Throwable) {
            failure = error
            throw error
        } finally {
            var cleanup: Throwable? = null
            withContext(NonCancellable) {
                for (characteristic in subscriptions.asReversed()) {
                    runCatching {
                        withTimeout(1_000) { driver.unsubscribe(peripheralId, BotaBluetoothUUIDs.StorageService, characteristic) }
                    }.exceptionOrNull()?.let { error ->
                        if (cleanup == null) cleanup = error else cleanup!!.addSuppressed(error)
                    }
                }
            }
            cleanup?.let { error ->
                uncertainOwner = owner
                if (failure != null) failure.addSuppressed(error) else throw EncryptedUploadV2HostException(
                    19u, false, message = "encrypted catalog cleanup is uncertain",
                ).also { it.addSuppressed(error) }
            }
        }
    }

    private fun ended() = EncryptedUploadV2HostException(12u, true, message = "encrypted catalog stream ended")
}
